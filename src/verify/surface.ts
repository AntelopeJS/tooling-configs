import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

import {
  isObject,
  isString,
  optStr,
  parseJson,
  type JsonObject,
  type JsonValue,
} from "../garden/json.ts";

/** The declared function surface of a package: function path to normalized signature text. */
export type Surface = Map<string, string>;

/** Paths added, removed or changed between two surfaces, each list sorted. */
export interface SurfaceDiff {
  added: string[];
  removed: string[];
  changed: { path: string; before: string; after: string }[];
}

/** The bump class of a change. */
export type Bump = "major" | "minor" | "patch";

/** Verdict of the interface minor-bump rule. */
export interface MinorVerdict {
  required: "minor" | "none";
  releases: string;
  ok: boolean;
  reason: string;
}

const MAX_DEPTH = 4;
const SIGNATURE_FLAGS =
  ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.WriteArrowStyleSignature;
const DECLARATION_FILE = /\.d\.[cm]?ts$/;

interface Walk {
  checker: ts.TypeChecker;
  folder: string;
  surface: Surface;
}

function exportedDeclaration(value: JsonValue): string | undefined {
  if (Array.isArray(value)) {
    return value.map(exportedDeclaration).find((found) => found !== undefined);
  }
  if (isString(value)) return DECLARATION_FILE.test(value) ? value : undefined;
  if (!isObject(value)) return undefined;
  const types = optStr(value, "types");
  if (types !== undefined) return types;
  return Object.values(value)
    .map(exportedDeclaration)
    .find((found) => found !== undefined);
}

function declarationEntries(manifest: JsonObject): Map<string, string> {
  const entries = new Map<string, string>();
  const exported = manifest.exports;
  if (exported === undefined) {
    const types = optStr(manifest, "types") ?? optStr(manifest, "typings");
    if (types !== undefined) entries.set(".", types);
    return entries;
  }
  const subpaths: [string, JsonValue][] =
    isObject(exported) && Object.keys(exported).some((key) => key[0] === ".")
      ? Object.entries(exported)
      : [[".", exported]];
  for (const [subpath, target] of subpaths) {
    if (subpath === "./package.json" || subpath.includes("*")) continue;
    const declaration = exportedDeclaration(target);
    if (declaration !== undefined) entries.set(subpath, declaration);
  }
  return entries;
}

function inPackage(walk: Walk, file: string): boolean {
  const path = relative(walk.folder, file);
  return (
    path !== "" &&
    !path.startsWith("..") &&
    !path.split(sep).includes("node_modules")
  );
}

function declaredHere(walk: Walk, symbol: ts.Symbol): boolean {
  return (symbol.declarations ?? []).some((declaration) =>
    inPackage(walk, declaration.getSourceFile().fileName),
  );
}

function resolveAlias(walk: Walk, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias
    ? walk.checker.getAliasedSymbol(symbol)
    : symbol;
}

function signatureTexts(
  walk: Walk,
  signatures: readonly ts.Signature[],
  kind: ts.SignatureKind,
): string[] {
  return signatures.map((signature) =>
    walk.checker
      .signatureToString(signature, undefined, SIGNATURE_FLAGS, kind)
      .replace(/\s+/g, " "),
  );
}

function callableText(walk: Walk, type: ts.Type): string | undefined {
  const callable = walk.checker.getNonNullableType(type);
  const texts = [
    ...signatureTexts(
      walk,
      callable.getCallSignatures(),
      ts.SignatureKind.Call,
    ),
    ...signatureTexts(
      walk,
      callable.getConstructSignatures(),
      ts.SignatureKind.Construct,
    ),
  ];
  return texts.length === 0 ? undefined : texts.join(" | ");
}

function typeOf(walk: Walk, symbol: ts.Symbol): ts.Type {
  return walk.checker.getTypeOfSymbol(symbol);
}

function isPublic(property: ts.Symbol): boolean {
  const hidden = ts.ModifierFlags.Private | ts.ModifierFlags.Protected;
  return (property.declarations ?? []).every(
    (declaration) => (ts.getCombinedModifierFlags(declaration) & hidden) === 0,
  );
}

function recordMembers(
  walk: Walk,
  type: ts.Type,
  prefix: string,
  skip: string,
): void {
  for (const property of walk.checker.getPropertiesOfType(type)) {
    if (property.name === skip || !isPublic(property)) continue;
    if (!declaredHere(walk, property)) continue;
    const text = callableText(walk, typeOf(walk, property));
    if (text !== undefined) walk.surface.set(`${prefix}${property.name}`, text);
  }
}

function recordClass(walk: Walk, symbol: ts.Symbol, path: string): void {
  recordMembers(walk, typeOf(walk, symbol), `${path}.`, "prototype");
  recordMembers(
    walk,
    walk.checker.getDeclaredTypeOfSymbol(symbol),
    `${path}.prototype.`,
    "",
  );
}

function isObjectType(type: ts.Type): type is ts.ObjectType {
  return (type.flags & ts.TypeFlags.Object) !== 0;
}

function isObjectLiteralType(walk: Walk, type: ts.Type): boolean {
  const owner = type.symbol;
  return (
    isObjectType(type) &&
    (type.objectFlags & ts.ObjectFlags.Anonymous) !== 0 &&
    owner !== undefined &&
    (owner.flags & ts.SymbolFlags.TypeLiteral) !== 0 &&
    declaredHere(walk, owner)
  );
}

function visit(
  walk: Walk,
  exported: ts.Symbol,
  path: string,
  trail: readonly ts.Symbol[],
): void {
  const symbol = resolveAlias(walk, exported);
  if (trail.includes(symbol)) return;
  const depth = path.split(":")[1]?.split(".").length ?? MAX_DEPTH;
  const value = symbol.flags & ts.SymbolFlags.Value;
  const type = value ? typeOf(walk, symbol) : undefined;
  const text = type && callableText(walk, type);
  if (text !== undefined) walk.surface.set(path, text);
  if (symbol.flags & ts.SymbolFlags.Class && declaredHere(walk, symbol)) {
    recordClass(walk, symbol, path);
    return;
  }
  if (depth >= MAX_DEPTH || !declaredHere(walk, symbol)) return;
  const next = [...trail, symbol];
  if (symbol.flags & ts.SymbolFlags.Module) {
    for (const member of walk.checker.getExportsOfModule(symbol)) {
      visit(walk, member, `${path}.${member.name}`, next);
    }
  } else if (type && text === undefined && isObjectLiteralType(walk, type)) {
    for (const member of walk.checker.getPropertiesOfType(type)) {
      visit(walk, member, `${path}.${member.name}`, next);
    }
  }
}

function unresolvedImports(walk: Walk, program: ts.Program): string[] {
  const missing: string[] = [];
  for (const file of program.getSourceFiles()) {
    if (!inPackage(walk, file.fileName)) continue;
    for (const statement of file.statements) {
      const specifier =
        (ts.isImportDeclaration(statement) ||
          ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier
          : undefined;
      if (specifier && !walk.checker.getSymbolAtLocation(specifier)) {
        missing.push(
          `${relative(walk.folder, file.fileName)} -> ${specifier.text}`,
        );
      }
    }
  }
  return missing;
}

/** The nearest `node_modules/@types` holding `@types/node`, so declarations importing `node:` built-ins resolve. */
function nodeTypeRoot(folder: string): string | undefined {
  let current = folder;
  while (
    !existsSync(join(current, "node_modules", "@types", "node", "package.json"))
  ) {
    if (dirname(current) === current) return undefined;
    current = dirname(current);
  }
  return join(current, "node_modules", "@types");
}

function readManifest(folder: string): JsonObject {
  const manifest = parseJson(
    readFileSync(join(folder, "package.json"), "utf8"),
  );
  if (!isObject(manifest))
    throw new Error(`${folder}: package.json is not an object`);
  return manifest;
}

/**
 * The function surface an extracted npm package declares, read from its `.d.ts` files.
 * Throws when an export's declaration file is missing or an import in the package's
 * own declarations cannot be resolved, because the surface would silently be partial.
 */
export function declaredSurface(packageFolder: string): Surface {
  const folder = realpathSync(resolve(packageFolder));
  const entries = declarationEntries(readManifest(folder));
  const files = new Map<string, string>();
  for (const [subpath, declaration] of entries) {
    const file = resolve(folder, declaration);
    if (!existsSync(file))
      throw new Error(`${subpath}: ${declaration} is missing`);
    files.set(subpath, file);
  }
  const nodeTypes = nodeTypeRoot(folder);
  const program = ts.createProgram([...files.values()], {
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    ...(nodeTypes === undefined
      ? { types: [] }
      : { typeRoots: [nodeTypes], types: ["node"] }),
  });
  const walk: Walk = {
    checker: program.getTypeChecker(),
    folder,
    surface: new Map(),
  };
  const missing = unresolvedImports(walk, program);
  if (missing.length > 0) {
    throw new Error(
      `unresolved imports in declarations: ${missing.join(", ")}${nodeTypes === undefined && missing.some((entry) => entry.includes("-> node:")) ? "; install @types/node so node: built-ins resolve" : ""}`,
    );
  }
  for (const [subpath, file] of files) {
    const source = program.getSourceFile(file);
    const module = source && walk.checker.getSymbolAtLocation(source);
    if (!module) continue;
    for (const member of walk.checker.getExportsOfModule(module)) {
      visit(walk, member, `${subpath}:${member.name}`, []);
    }
  }
  return walk.surface;
}

/** The paths added, removed and changed from `published` to `head`, each sorted. */
export function diffSurface(published: Surface, head: Surface): SurfaceDiff {
  const added = [...head.keys()].filter((path) => !published.has(path));
  const removed = [...published.keys()].filter((path) => !head.has(path));
  const changed = [...head].flatMap(([path, after]) => {
    const before = published.get(path);
    return before !== undefined && before !== after
      ? [{ path, before, after }]
      : [];
  });
  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

interface Version {
  core: [number, number, number];
  pre: string[];
}

function parseVersion(text: string): Version {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(
    text.trim(),
  );
  if (!match) throw new Error(`not a semver version: ${text}`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  };
}

function comparePre(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  const numeric = /^\d+$/;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const [left, right] = [a[index] ?? "", b[index] ?? ""];
    const bothNumeric = numeric.test(left) && numeric.test(right);
    const order = bothNumeric
      ? Number(left) - Number(right)
      : numeric.test(left) === numeric.test(right)
        ? left.localeCompare(right)
        : numeric.test(left)
          ? -1
          : 1;
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

function compareVersions(a: Version, b: Version): number {
  return (
    a.core[0] - b.core[0] ||
    a.core[1] - b.core[1] ||
    a.core[2] - b.core[2] ||
    comparePre(a.pre, b.pre)
  );
}

function increment(version: Version, bump: Bump): Version {
  const [major, minor, patch] = version.core;
  if (bump === "major") return { core: [major + 1, 0, 0], pre: [] };
  if (bump === "minor") return { core: [major, minor + 1, 0], pre: [] };
  return {
    core:
      version.pre.length > 0
        ? [major, minor, patch]
        : [major, minor, patch + 1],
    pre: [],
  };
}

function format(version: Version): string {
  const core = version.core.join(".");
  return version.pre.length > 0 ? `${core}-${version.pre.join(".")}` : core;
}

function titleBump(title: string): Bump {
  const match = /^(\w+)(?:\([^)]*\))?(!)?:/.exec(title.trim());
  if (match?.[2] === "!" || title.includes("BREAKING CHANGE")) return "major";
  return match?.[1] === "feat" ? "minor" : "patch";
}

/**
 * The bump changelogen 0.5.7 applies to `currentVersion` for these commit titles:
 * `!` or a `BREAKING CHANGE` footer is major, `feat` minor, anything else patch,
 * and on a `0.x` version major becomes minor and minor becomes patch.
 */
export function releaseType(currentVersion: string, titles: string[]): Bump {
  const order: Bump[] = ["patch", "minor", "major"];
  const highest = titles
    .map(titleBump)
    .reduce(
      (top, bump) => (order.indexOf(bump) > order.indexOf(top) ? bump : top),
      "patch",
    );
  if (!currentVersion.startsWith("0.")) return highest;
  return highest === "major" ? "minor" : "patch";
}

function listPaths(diff: SurfaceDiff): string {
  const parts = [
    diff.added.length > 0 ? `added ${diff.added.join(", ")}` : "",
    diff.changed.length > 0
      ? `changed ${diff.changed.map((entry) => entry.path).join(", ")}`
      : "",
    diff.removed.length > 0 ? `removed ${diff.removed.join(", ")}` : "",
  ];
  return parts.filter((part) => part !== "").join("; ");
}

/**
 * Judges the interface minor-bump rule: an added, changed or removed function needs a
 * release of at least the next minor of the published version.
 */
export function minorRule(input: {
  published: string | null;
  headVersion: string;
  titles: string[];
  diff: SurfaceDiff;
}): MinorVerdict {
  const { published, headVersion, titles, diff } = input;
  if (published === null) {
    return {
      required: "none",
      releases: headVersion,
      ok: true,
      reason:
        "never published: the first release has no surface to compare against",
    };
  }
  const base = parseVersion(published);
  const head = parseVersion(headVersion);
  const releases =
    compareVersions(head, base) > 0
      ? headVersion
      : format(increment(base, releaseType(published, titles)));
  const required =
    diff.added.length + diff.changed.length + diff.removed.length > 0
      ? "minor"
      : "none";
  if (required === "none") {
    return {
      required,
      releases,
      ok: true,
      reason: `no function added, changed or removed against ${published}: no minor required`,
    };
  }
  const floor = format(increment(base, "minor"));
  const ok = compareVersions(parseVersion(releases), parseVersion(floor)) >= 0;
  const facts = `${listPaths(diff)}: needs at least ${floor} against ${published}, this change releases as ${releases}`;
  const title =
    base.core[0] === 0
      ? "a `feat!:` commit title (changelogen turns a breaking change into a minor on 0.x)"
      : "a `feat:` commit title";
  return {
    required,
    releases,
    ok,
    reason: ok
      ? facts
      : `${facts}. Fix: use ${title}, or run the release workflow with release-version ${floor}`,
  };
}
