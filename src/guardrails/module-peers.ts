import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { coerce, maxSatisfying, satisfies, valid, validRange } from "semver";
import ts from "typescript";

import {
  isObject,
  type JsonValue,
  optChild,
  parseJson,
  stringValues,
} from "../garden/json.ts";
import { Unreadable, keys, mapping, scalar } from "./lockfile-reading.ts";
import {
  type ListedRelease,
  type Packument,
  downloadTarball,
  packument,
  registry,
} from "./registry.ts";
import { lockfileDocuments } from "./singleton-packages.ts";
import { tarEntry } from "./tar-entry.ts";

const ROOT_LOCK = "pnpm-lock.yaml";
const MODULE_LOCKS = "antelope-lock";
const PROJECT_CONFIG = "antelope.config.ts";
const FRONTEND_MANIFEST = "frontend-vue/package.json";
const RENDERER = "@antelopejs/dms-frontend";

/** The importer fields whose versions a project install puts in the root `node_modules`. */
const LOCKED_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
] as const;

/** A module the project installs: its package, the version, range or dist-tag that picks its release, and where that pick is written. */
interface Installed {
  name: string;
  pick: string;
  from: string;
}

/** A range a module release declares on another package, and where in the release it declares it. */
interface Requirement {
  peer: string;
  range: string;
  where: string;
}

/** The modules `antelope-lock/` holds, from its `<name>@<version>` and `@<scope>/<name>@<version>` folders. */
function lockedModules(root: string): Installed[] {
  const folder = join(root, MODULE_LOCKS);
  if (!existsSync(folder)) return [];
  const folders = (path: string): string[] =>
    readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  return folders(folder)
    .flatMap((entry) =>
      entry.startsWith("@")
        ? folders(join(folder, entry)).map((name) => `${entry}/${name}`)
        : [entry],
    )
    .flatMap((entry): Installed[] => {
      const at = entry.lastIndexOf("@");
      return at > 0
        ? [
            {
              name: entry.slice(0, at),
              pick: entry.slice(at + 1),
              from: `${MODULE_LOCKS}/`,
            },
          ]
        : [];
    });
}

/** Where a field of a package source comes from: a string, the argument at a position of the local function that returns the source, or an expression this check cannot read. */
type FieldOrigin = { text: string } | { argument: number } | "unreadable";

/** The `package` and `version` origins of a package source; an absent `version` picks the `latest` dist-tag. */
interface SourceOrigins {
  package: FieldOrigin;
  version: FieldOrigin;
}

const LATEST: FieldOrigin = { text: "latest" };

/** `expression` without the `as`, `satisfies` and parentheses around it, as in `"package" as const`. */
function unwrapped(expression: ts.Expression): ts.Expression {
  return ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression)
    ? unwrapped(expression.expression)
    : expression;
}

/** The expression a property `key` of an object literal holds, shorthand included, without {@link unwrapped} wrappers. */
function propertyValue(
  node: ts.ObjectLiteralExpression,
  key: string,
): ts.Expression | undefined {
  for (const property of node.properties) {
    if (
      ts.isShorthandPropertyAssignment(property) &&
      property.name.text === key
    )
      return property.name;
    if (
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === key
    )
      return unwrapped(property.initializer);
  }
  return undefined;
}

/** The function an object literal is returned from and the name it is called by, when a declaration names it. */
function enclosingHelper(
  node: ts.Node,
): { name: string; parameters: string[] } | undefined {
  let scope = node.parent;
  while (!ts.isSourceFile(scope) && !ts.isFunctionLike(scope))
    scope = scope.parent;
  if (!ts.isFunctionLike(scope)) return undefined;
  const declared =
    ts.isFunctionDeclaration(scope) && scope.name
      ? scope.name
      : ts.isVariableDeclaration(scope.parent) &&
          ts.isIdentifier(scope.parent.name)
        ? scope.parent.name
        : undefined;
  return declared
    ? {
        name: declared.text,
        parameters: scope.parameters.map((parameter) =>
          ts.isIdentifier(parameter.name) ? parameter.name.text : "",
        ),
      }
    : undefined;
}

function fieldOrigin(
  value: ts.Expression | undefined,
  parameters: readonly string[],
): FieldOrigin | undefined {
  if (value === undefined) return undefined;
  if (ts.isStringLiteralLike(value)) return { text: value.text };
  if (ts.isIdentifier(value) && parameters.includes(value.text))
    return { argument: parameters.indexOf(value.text) };
  return "unreadable";
}

/** The text an origin resolves to given `args`, the arguments of a call to the function returning the source; `undefined` when it is not a string. */
function resolved(
  origin: FieldOrigin,
  args: readonly ts.Expression[],
): string | undefined {
  if (origin === "unreadable") return undefined;
  if ("text" in origin) return origin.text;
  const value = args[origin.argument];
  return value && ts.isStringLiteralLike(value) ? value.text : undefined;
}

/** The modules of `antelope.config.ts`, and a failure line for each package source whose package or version is not a string. */
interface ConfigModules {
  modules: Installed[];
  failure: string;
}

/**
 * Each `{ type: "package", package, version }` source of `antelope.config.ts`, read without running it: a source whose
 * fields are strings, and each call, with string arguments, of a local function that returns a source built from its
 * parameters.
 */
function configModules(root: string): ConfigModules {
  const path = join(root, PROJECT_CONFIG);
  if (!existsSync(path)) return { modules: [], failure: "" };
  const file = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const sources: {
    at: ts.Node;
    origins: SourceOrigins;
    args: ts.Expression[];
  }[] = [];
  const helpers = new Map<string, SourceOrigins>();
  const findSources = (node: ts.Node): void => {
    const type = ts.isObjectLiteralExpression(node)
      ? propertyValue(node, "type")
      : undefined;
    if (
      ts.isObjectLiteralExpression(node) &&
      type &&
      ts.isStringLiteralLike(type) &&
      type.text === "package"
    ) {
      const helper = enclosingHelper(node);
      const parameters = helper?.parameters ?? [];
      const origins: SourceOrigins = {
        package:
          fieldOrigin(propertyValue(node, "package"), parameters) ??
          "unreadable",
        version:
          fieldOrigin(propertyValue(node, "version"), parameters) ?? LATEST,
      };
      const local = [origins.package, origins.version].every(
        (origin) => origin !== "unreadable" && "text" in origin,
      );
      if (helper && !local) helpers.set(helper.name, origins);
      else sources.push({ at: node, origins, args: [] });
    }
    ts.forEachChild(node, findSources);
  };
  const findCalls = (node: ts.Node): void => {
    const origins =
      ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        ? helpers.get(node.expression.text)
        : undefined;
    if (origins && ts.isCallExpression(node))
      sources.push({ at: node, origins, args: [...node.arguments] });
    ts.forEachChild(node, findCalls);
  };
  findSources(file);
  findCalls(file);
  const modules: Installed[] = [];
  let failure = "";
  for (const { at, origins, args } of sources) {
    const name = resolved(origins.package, args);
    const pick = resolved(origins.version, args);
    if (name !== undefined && pick !== undefined)
      modules.push({ name, pick, from: `${PROJECT_CONFIG}: "${pick}"` });
    else {
      const line = file.getLineAndCharacterOfPosition(at.getStart(file)).line;
      failure += `${PROJECT_CONFIG}:${line + 1} holds a package source whose package or version is not a string, so this check cannot tell which release it installs. Write both as strings, or pass them as strings to a local function that returns the source.\n`;
    }
  }
  return { modules, failure };
}

/** The modules of `antelope-lock/`, then each module of `antelope.config.ts` that `antelope-lock/` does not hold, and what of the config could not be read. */
function installedModules(root: string): ConfigModules {
  const locked = lockedModules(root);
  const names = new Set(locked.map(({ name }) => name));
  const config = configModules(root);
  const modules = [
    ...locked,
    ...config.modules.filter(({ name }) => !names.has(name)),
  ];
  return {
    modules: [
      ...new Map(
        modules.map((module) => [`${module.name}@${module.pick}`, module]),
      ).values(),
    ],
    failure: config.failure,
  };
}

/** The version importer `.` of each document of the lockfile at `path` locks each direct dependency at, without its peer suffix; a `file:` tarball resolves to the version its package entry records. */
function lockedVersions(path: string): Map<string, string> {
  const locked = new Map<string, string>();
  for (const document of lockfileDocuments(path)) {
    const importer = mapping(mapping(document, "importers"), ".") ?? document;
    const packages = mapping(document, "packages");
    for (const field of LOCKED_FIELDS) {
      const entries = mapping(importer, field);
      for (const name of keys(entries)) {
        const reference = (
          scalar(mapping(entries, name), "version") ?? scalar(entries, name)
        )?.split("(")[0];
        if (reference === undefined) continue;
        const version =
          valid(reference) ??
          scalar(mapping(packages, `${name}@${reference}`), "version");
        if (version !== undefined && valid(version) !== null)
          locked.set(name, version);
      }
    }
  }
  return locked;
}

/**
 * The `engines["@antelopejs/dms-frontend"]` range a `frontend-vue/package.json` declares, which `ajs-dms build` holds the
 * project's renderer to. Its `peerDependencies` resolve in the dashboard workspace `ajs-dms` installs apart from the
 * project, never from the root lockfile, so they do not count.
 */
function rendererRange(manifest: JsonValue): Requirement[] {
  const range = isObject(manifest)
    ? stringValues(optChild(manifest, "engines")).get(RENDERER)
    : undefined;
  return range === undefined
    ? []
    : [{ peer: RENDERER, range, where: `${FRONTEND_MANIFEST} engines` }];
}

/** The ranges `release` declares in its `peerDependencies` and in the `frontend-vue/package.json` its tarball holds; `undefined` when the tarball cannot be downloaded. */
async function declaredRanges(
  release: ListedRelease,
): Promise<Requirement[] | undefined> {
  const tarball =
    release.tarball === undefined
      ? undefined
      : await downloadTarball(release.tarball);
  if (tarball === undefined) return undefined;
  const frontend = tarEntry(tarball, `package/${FRONTEND_MANIFEST}`);
  return [
    ...[...release.peerDependencies].map(([peer, range]) => ({
      peer,
      range,
      where: "package.json peerDependencies",
    })),
    ...(frontend === undefined ? [] : rendererRange(parseJson(frontend))),
  ];
}

/** Whether `range` admits `version`, a prerelease counting as the release it leads to, as `ajs-dms build` judges a frontend's range. */
const admits = (range: string, version: string): boolean =>
  satisfies(coerce(version)?.version ?? version, range);

async function moduleReport(
  module: Installed,
  listing: Packument | undefined,
  locked: ReadonlyMap<string, string>,
): Promise<string> {
  if (listing === undefined)
    return `${module.from} names "${module.name}", which could not be read from ${registry()}.\n`;
  const version =
    listing.tags.get(module.pick) ??
    (validRange(module.pick) === null
      ? null
      : maxSatisfying([...listing.releases.keys()], module.pick));
  const release = version === null ? undefined : listing.releases.get(version);
  if (version === null || release === undefined)
    return `${module.from} names "${module.name}", which has no release in "${module.pick}" on ${registry()}.\n`;
  const declared = await declaredRanges(release);
  if (declared === undefined)
    return `The tarball of ${module.name}@${version} could not be downloaded from ${release.tarball ?? registry()}.\n`;
  return declared
    .flatMap(({ peer, range, where }) => {
      const at = locked.get(peer);
      return at === undefined || validRange(range) === null || admits(range, at)
        ? []
        : [
            `${ROOT_LOCK} locks "${peer}" at ${at}, outside "${range}", the range ${module.name}@${version} (${module.from}) declares in ${where}.\n  Set "${peer}" in package.json to a version in "${range}", then run \`pnpm install\`.\n`,
          ];
    })
    .join("");
}

/** Whether the repository has a root `pnpm-lock.yaml` and installs modules through `antelope-lock/` or `antelope.config.ts`. */
export function hasModulePeers(root: string): boolean {
  return (
    existsSync(join(root, ROOT_LOCK)) &&
    (existsSync(join(root, MODULE_LOCKS)) ||
      existsSync(join(root, PROJECT_CONFIG)))
  );
}

/**
 * Fails when the root `pnpm-lock.yaml` locks a direct dependency outside a range an installed module release declares on
 * it: under its `peerDependencies`, or in its `frontend-vue/package.json` `engines["@antelopejs/dms-frontend"]`, the range
 * `ajs-dms build` holds the dashboard's renderer to. The installed release
 * is the one `antelope-lock/` holds, else the newest the `antelope.config.ts` range or dist-tag admits, as a build installs
 * it. Reads each release's packument and tarball from the registry, and nothing else over the network. Returns what
 * failed, naming the module, the dependency, the range, the locked version and the fix; empty when every range admits
 * its locked version.
 */
export async function checkModulePeers(root: string): Promise<string> {
  let locked: Map<string, string>;
  try {
    locked = lockedVersions(join(root, ROOT_LOCK));
  } catch (error) {
    if (error instanceof Unreadable)
      return `${ROOT_LOCK}: could not read it as a lockfile version this check knows.\n`;
    throw error;
  }
  const listings = new Map<string, Promise<Packument | undefined>>();
  const listing = (name: string): Promise<Packument | undefined> => {
    const read = listings.get(name) ?? packument(name);
    listings.set(name, read);
    return read;
  };
  const { modules, failure } = installedModules(root);
  const reports = await Promise.all(
    modules.map(async (module) =>
      moduleReport(module, await listing(module.name), locked),
    ),
  );
  return failure + reports.join("");
}
