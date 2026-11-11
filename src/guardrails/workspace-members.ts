import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type ts from "typescript";
import {
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  type Document,
  type Node,
} from "yaml";

import { workspaceDirectories } from "./docs-compat.ts";
import {
  parseManifest,
  serializeManifest,
  type Manifest,
  type toolingVersions,
} from "./package.ts";
import { typescript } from "./parser.ts";

/** What aligning the workspace members wrote, and the members it could not align. */
export interface MemberAlignment {
  paths: string[];
  failures: string[];
}

type OptionFlag =
  | { kind: "switch"; flag: string }
  | { kind: "count"; flag: string }
  | { kind: "severity"; flag: string };

/** Each oxlint `options` key, which oxlint reads only from the root config, and the flag that carries it on a member's own oxlint run. */
const OPTION_FLAGS = new Map<string, OptionFlag>([
  ["typeAware", { kind: "switch", flag: "--type-aware" }],
  ["typeCheck", { kind: "switch", flag: "--type-check" }],
  ["denyWarnings", { kind: "switch", flag: "--deny-warnings" }],
  ["maxWarnings", { kind: "count", flag: "--max-warnings" }],
  [
    "reportUnusedDisableDirectives",
    { kind: "severity", flag: "--report-unused-disable-directives-severity" },
  ],
]);

/** The oxlint config names oxlint discovers in a nested directory. */
const LINT_CONFIGS = [
  "oxlint.config.ts",
  "oxlint.config.mts",
  "oxlint.config.cts",
  "oxlint.config.js",
  "oxlint.config.mjs",
  "oxlint.config.cjs",
  ".oxlintrc.json",
  ".oxlintrc.jsonc",
] as const;

/** A command word `oxlint` in a script, not `oxlint-tsgolint` or a path ending in it. */
const OXLINT_COMMAND = /(^|[\s;&|(])oxlint(?=$|[\s;&|)])/g;

function unwrapped(node: ts.Expression): ts.Expression {
  const compiler = typescript();
  let current = node;
  while (
    compiler.isParenthesizedExpression(current) ||
    compiler.isAsExpression(current) ||
    compiler.isSatisfiesExpression(current)
  )
    current = current.expression;
  return current;
}

function variableInitializer(
  source: ts.SourceFile,
  name: string,
): ts.Expression | undefined {
  const compiler = typescript();
  for (const statement of source.statements)
    if (compiler.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (
          compiler.isIdentifier(declaration.name) &&
          declaration.name.text === name
        )
          return declaration.initializer;
  return undefined;
}

/** The object literal a config exports: itself, the first argument of `defineConfig(...)`, or a same-file variable holding either. */
function configLiteral(
  source: ts.SourceFile,
  node: ts.Expression | undefined,
  seen = new Set<string>(),
): ts.ObjectLiteralExpression | undefined {
  const compiler = typescript();
  if (node === undefined) return undefined;
  const value = unwrapped(node);
  if (compiler.isObjectLiteralExpression(value)) return value;
  if (compiler.isCallExpression(value))
    return configLiteral(source, value.arguments[0], seen);
  if (!compiler.isIdentifier(value) || seen.has(value.text)) return undefined;
  seen.add(value.text);
  return configLiteral(source, variableInitializer(source, value.text), seen);
}

function exportedConfig(
  path: string,
  text: string,
): ts.ObjectLiteralExpression | undefined {
  const compiler = typescript();
  if (path.endsWith(".json") || path.endsWith(".jsonc")) {
    const source = compiler.parseJsonText(path, text);
    const [statement] = source.statements;
    return statement && configLiteral(source, statement.expression);
  }
  const source = compiler.createSourceFile(
    path,
    text,
    compiler.ScriptTarget.Latest,
    true,
  );
  const exported = source.statements.find(
    (statement): statement is ts.ExportAssignment =>
      compiler.isExportAssignment(statement) && !statement.isExportEquals,
  );
  return configLiteral(source, exported?.expression);
}

function propertyName(
  element: ts.ObjectLiteralElementLike,
): string | undefined {
  const compiler = typescript();
  const name = element.name;
  return name !== undefined &&
    (compiler.isIdentifier(name) || compiler.isStringLiteralLike(name))
    ? name.text
    : undefined;
}

/** The flag that carries one option value, `""` for a switch set to `false`, or undefined when the value has no flag. */
function optionFlag(
  entry: OptionFlag,
  value: ts.Expression,
): string | undefined {
  const compiler = typescript();
  switch (entry.kind) {
    case "switch":
      if (value.kind === compiler.SyntaxKind.TrueKeyword) return entry.flag;
      return value.kind === compiler.SyntaxKind.FalseKeyword ? "" : undefined;
    case "count":
      return compiler.isNumericLiteral(value)
        ? `${entry.flag}=${value.text}`
        : undefined;
    case "severity":
      return compiler.isStringLiteralLike(value)
        ? `${entry.flag}=${value.text}`
        : undefined;
  }
}

/** The flags an `options` literal stands for, or the keys no flag can carry. */
function optionFlags(
  options: ts.Expression,
): { flags: string[] } | { unsupported: string[] } {
  const compiler = typescript();
  const literal = unwrapped(options);
  if (!compiler.isObjectLiteralExpression(literal))
    return { unsupported: ["options"] };
  const flags: string[] = [];
  const unsupported: string[] = [];
  for (const element of literal.properties) {
    const name = propertyName(element) ?? element.getText();
    const entry = OPTION_FLAGS.get(name);
    const flag =
      entry && compiler.isPropertyAssignment(element)
        ? optionFlag(entry, unwrapped(element.initializer))
        : undefined;
    if (flag === undefined) unsupported.push(name);
    else if (flag) flags.push(flag);
  }
  return unsupported.length ? { unsupported } : { flags };
}

/** `text` without `property`, its separating comma and the line it sat on. */
function withoutProperty(
  text: string,
  config: ts.ObjectLiteralExpression,
  property: ts.ObjectLiteralElementLike,
): string {
  const elements = config.properties;
  const index = elements.indexOf(property);
  const next = elements[index + 1];
  const previous = elements[index - 1];
  if (next)
    return (
      text.slice(0, property.getFullStart()) + text.slice(next.getFullStart())
    );
  if (previous) return text.slice(0, previous.end) + text.slice(property.end);
  return text.slice(0, config.getStart()) + "{}" + text.slice(config.end);
}

type ConfigMove =
  | { kind: "none" }
  | { kind: "moved"; text: string; flags: string[] }
  | { kind: "unsupported"; keys: string[] };

/** The config without its root-only `options`, and the flags that keep the member's own run the same. */
function moveOptions(path: string, text: string): ConfigMove {
  const config = exportedConfig(path, text);
  const options = config?.properties.find(
    (element) => propertyName(element) === "options",
  );
  if (config === undefined || options === undefined) return { kind: "none" };
  if (!typescript().isPropertyAssignment(options))
    return { kind: "unsupported", keys: ["options"] };
  const result = optionFlags(options.initializer);
  if ("unsupported" in result)
    return { kind: "unsupported", keys: result.unsupported };
  return {
    kind: "moved",
    text: withoutProperty(text, config, options),
    flags: result.flags,
  };
}

/** A shell separator that ends one command of a script. */
const COMMAND_END = /&&|\|\||[;|]/;

/** `script` with `flags` after each `oxlint` command word, skipping a flag that command already passes. */
function withFlags(script: string, flags: readonly string[]): string {
  return script.replace(
    OXLINT_COMMAND,
    (match: string, before: string, offset: number) => {
      const rest = script.slice(offset + match.length);
      const command = rest.split(COMMAND_END)[0] ?? rest;
      const missing = flags.filter(
        (flag) => !command.includes(flag.split("=")[0] ?? flag),
      );
      return missing.length ? `${before}oxlint ${missing.join(" ")}` : match;
    },
  );
}

const ALIGNED_TOOLS = [
  "@antelopejs/tooling-configs",
  "oxlint",
  "oxlint-tsgolint",
  "oxfmt",
  "knip",
  "lefthook",
] as const;

const CATALOG = "catalog:";

/** Each catalog the workspace declares, by name, with the range it gives each package; `catalog` is the one named `default`. */
type Catalogs = Map<string, Map<string, string>>;

/** The scalar keys of the mapping `node` holds, each with its value node, following YAML aliases and `<<` merge keys; a key the mapping sets itself comes after the merged one it overrides. */
function mapPairs(document: Document, node: Node | null): [string, unknown][] {
  const map = isAlias(node) ? node.resolve(document) : node;
  if (!isMap(map)) return [];
  const merged: [string, unknown][] = [];
  const own: [string, unknown][] = [];
  for (const { key, value } of map.items) {
    if (!isScalar(key)) continue;
    if (key.value !== "<<") {
      own.push([
        String(key.value),
        isAlias(value) ? value.resolve(document) : value,
      ]);
      continue;
    }
    const sources = isSeq(value) ? [...value.items].reverse() : [value];
    for (const source of sources)
      if (isNode(source)) merged.push(...mapPairs(document, source));
  }
  return [...merged, ...own];
}

/** The scalar keys of the mapping at `path`, each with its value node. */
function mapEntries(document: Document, path: string[]): [string, unknown][] {
  let pairs = mapPairs(document, document.contents);
  for (const key of path) {
    const value = new Map(pairs).get(key);
    pairs = isNode(value) ? mapPairs(document, value) : [];
  }
  return pairs;
}

/** The package names of the catalog at `path`, each with its range. */
function catalogEntries(
  document: Document,
  path: string[],
): [string, string][] {
  return mapEntries(document, path).flatMap(([name, value]) =>
    isScalar(value) ? [[name, String(value.value)]] : [],
  );
}

/** The document that declares the workspace's catalogs and the paths in it that hold `catalog` and `catalogs`: pnpm's `pnpm-workspace.yaml`, else Bun's root package.json, under `workspaces` or at its top level. */
interface CatalogSource {
  document: Document;
  prefixes: string[][];
}

function catalogSource(root: string): CatalogSource {
  const pnpm = join(root, "pnpm-workspace.yaml");
  if (existsSync(pnpm))
    return {
      document: parseDocument(readFileSync(pnpm, "utf8")),
      prefixes: [[]],
    };
  return {
    document: parseDocument(readFileSync(join(root, "package.json"), "utf8")),
    prefixes: [["workspaces"], []],
  };
}

function workspaceCatalogs(root: string): Catalogs {
  const { document, prefixes } = catalogSource(root);
  const catalogs: Catalogs = new Map();
  const add = (name: string, path: string[]) =>
    catalogs.set(
      name,
      new Map([
        ...(catalogs.get(name) ?? []),
        ...catalogEntries(document, path),
      ]),
    );
  for (const prefix of prefixes) {
    add("default", [...prefix, "catalog"]);
    for (const [name] of mapEntries(document, [...prefix, "catalogs"]))
      add(name, [...prefix, "catalogs", name]);
  }
  return catalogs;
}

/** The range `spec` installs `name` at: `spec` itself, its catalog entry for a `catalog:` spec, or undefined for another protocol or a path. */
function resolvedRange(
  catalogs: Catalogs,
  name: string,
  spec: string,
): string | undefined {
  if (spec.startsWith(CATALOG))
    return catalogs.get(spec.slice(CATALOG.length) || "default")?.get(name);
  return /[:/]/.test(spec) ? undefined : spec;
}

/** A pack tool's spec at the root, which a member copies, and the range it resolves to. */
interface RootSpec {
  spec: string;
  range: string;
}

/** The spec of each pack tool at the root: the one it declares, else the one `--init` and sync add. A `catalog:` spec resolves the same in every member; another protocol or a path stays root-only, since a member would resolve it elsewhere. */
function rootSpecs(
  root: Manifest,
  versions: ReturnType<typeof toolingVersions>,
  catalogs: Catalogs,
): Map<string, RootSpec> {
  const declared = new Map<string, string>([
    ["@antelopejs/tooling-configs", `^${versions.pack}`],
    ["oxlint", versions.oxlint],
    ["oxlint-tsgolint", versions.tsgolint],
    ["oxfmt", versions.oxfmt],
    ["knip", versions.knip],
    ["lefthook", versions.lefthook],
  ]);
  for (const field of [root.dependencies, root.devDependencies])
    for (const [name, spec] of Object.entries(field ?? {}))
      if (declared.has(name)) declared.set(name, spec);
  const specs = new Map<string, RootSpec>();
  for (const [name, spec] of declared) {
    const range = resolvedRange(catalogs, name, spec);
    if (range !== undefined) specs.set(name, { spec, range });
  }
  return specs;
}

/** Sets each pack tool the member declares as a plain range to the root's spec, so the workspace installs one copy of the pack, and names each member `catalog:` spec that resolves to another range; returns whether it changed one. */
function alignRanges(
  member: Manifest,
  manifestPath: string,
  specs: Map<string, RootSpec>,
  catalogs: Catalogs,
  failures: string[],
): boolean {
  let changed = false;
  for (const field of [member.dependencies, member.devDependencies])
    for (const name of ALIGNED_TOOLS) {
      const declared =
        field && Object.hasOwn(field, name) ? field[name] : undefined;
      const wanted = specs.get(name);
      if (
        !field ||
        declared === undefined ||
        wanted === undefined ||
        declared === wanted.spec
      )
        continue;
      if (declared.startsWith(CATALOG)) {
        const range = resolvedRange(catalogs, name, declared);
        if (range !== undefined && range !== wanted.range)
          failures.push(
            `${manifestPath} declares ${name} as ${declared}, which resolves to ${range}, while the root resolves it to ${wanted.range}, so the workspace would install two copies. Give both the same catalog entry or range, then rerun antelopejs-sync --init.`,
          );
        continue;
      }
      if (declared.includes(":")) continue;
      field[name] = wanted.spec;
      changed = true;
    }
  return changed;
}

function alignMember(
  root: string,
  directory: string,
  workspace: { specs: Map<string, RootSpec>; catalogs: Catalogs },
  result: MemberAlignment,
): void {
  const manifestPath = join(root, directory, "package.json");
  const current = readFileSync(manifestPath, "utf8");
  const member = parseManifest(current);
  let changed = alignRanges(
    member,
    `${directory}/package.json`,
    workspace.specs,
    workspace.catalogs,
    result.failures,
  );
  for (const name of LINT_CONFIGS) {
    const relative = `${directory}/${name}`;
    const path = join(root, relative);
    if (!existsSync(path)) continue;
    const move = moveOptions(relative, readFileSync(path, "utf8"));
    if (move.kind === "unsupported")
      result.failures.push(
        `${relative} sets oxlint options that oxlint reads only from the root config and that no command-line flag carries (${move.keys.join(", ")}). Move them to the root config or remove them, then rerun antelopejs-sync --init.`,
      );
    if (move.kind !== "moved") continue;
    writeFileSync(path, move.text);
    result.paths.push(relative);
    for (const [script, command] of Object.entries(member.scripts ?? {})) {
      const flagged = withFlags(command, move.flags);
      if (flagged === command || !member.scripts) continue;
      member.scripts[script] = flagged;
      changed = true;
    }
  }
  if (!changed) return;
  writeFileSync(manifestPath, serializeManifest(member, current));
  result.paths.push(`${directory}/package.json`);
}

/**
 * Prepares each workspace member for the root's lint and install: the pack
 * tools it declares move to the root's ranges, and the `options` of its oxlint
 * config, which oxlint accepts only in the root config, move to the same flags
 * on the member's `oxlint` scripts.
 */
export function alignWorkspaceMembers(
  root: string,
  manifest: Manifest,
  versions: ReturnType<typeof toolingVersions>,
): MemberAlignment {
  const catalogs = workspaceCatalogs(root);
  const workspace = {
    specs: rootSpecs(manifest, versions, catalogs),
    catalogs,
  };
  const result: MemberAlignment = { paths: [], failures: [] };
  for (const directory of workspaceDirectories(root))
    alignMember(root, directory, workspace, result);
  return result;
}
