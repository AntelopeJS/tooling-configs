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

/** A module the project installs: its package, the version, range or dist-tag that picks its release, the `antelope-lock/` version a build replays for that pick if any, and where the pick is written. */
interface Installed {
  name: string;
  pick: string;
  recorded?: string;
  from: string;
}

/** A range a module release declares on another package, where in the release it declares it, and whether a prerelease counts as the release it leads to. */
interface Requirement {
  peer: string;
  range: string;
  where: string;
  releaseLine: boolean;
}

/** The versions `antelope-lock/` records for each package, from its `<name>@<version>` and `@<scope>/<name>@<version>` folders. */
function recordedVersions(root: string): Map<string, string[]> {
  const folder = join(root, MODULE_LOCKS);
  const recorded = new Map<string, string[]>();
  if (!existsSync(folder)) return recorded;
  const folders = (path: string): string[] =>
    readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  folders(folder)
    .flatMap((entry) =>
      entry.startsWith("@")
        ? folders(join(folder, entry)).map((name) => `${entry}/${name}`)
        : [entry],
    )
    .forEach((entry) => {
      const at = entry.lastIndexOf("@");
      if (at <= 0) return;
      const name = entry.slice(0, at);
      recorded.set(name, [...(recorded.get(name) ?? []), entry.slice(at + 1)]);
    });
  return recorded;
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
      const fromArguments = [origins.package, origins.version].some(
        (origin) => origin !== "unreadable" && "argument" in origin,
      );
      const unreadable = [origins.package, origins.version].includes(
        "unreadable",
      );
      if (helper && fromArguments && !unreadable)
        helpers.set(helper.name, origins);
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

/**
 * The modules of `antelope.config.ts`, each with the version `ajs` replays from `antelope-lock/`: the highest recorded
 * version a range admits. An exact version or a dist-tag replays none, and resolves on the registry.
 */
function installedModules(root: string): ConfigModules {
  const records = recordedVersions(root);
  const config = configModules(root);
  const modules = config.modules.map((module): Installed => {
    const replayed =
      valid(module.pick) === null && validRange(module.pick) !== null
        ? maxSatisfying(records.get(module.name) ?? [], module.pick)
        : null;
    return replayed === null
      ? module
      : {
          ...module,
          recorded: replayed,
          from: `${MODULE_LOCKS}/, for ${module.from}`,
        };
  });
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
    : [
        {
          peer: RENDERER,
          range,
          where: `${FRONTEND_MANIFEST} engines`,
          releaseLine: true,
        },
      ];
}

/** The ranges a release declares, or why its tarball could not be read. */
type Declared = { requirements: Requirement[] } | { failure: string };

/** The renderer range the `frontend-vue/package.json` in the tarball at `url` declares, or what kept it from being read. */
async function tarballRequirements(url: string | undefined): Promise<Declared> {
  const tarball = url === undefined ? undefined : await downloadTarball(url);
  if (tarball === undefined)
    return { failure: `could not be downloaded from ${url ?? registry()}` };
  try {
    const frontend = tarEntry(tarball, `package/${FRONTEND_MANIFEST}`);
    return {
      requirements:
        frontend === undefined ? [] : rendererRange(parseJson(frontend)),
    };
  } catch {
    return {
      failure: `from ${url} is not a gzipped tarball holding a JSON ${FRONTEND_MANIFEST}`,
    };
  }
}

/**
 * The ranges `release` declares in its `peerDependencies` and, when the root lockfile locks the renderer, in the
 * `frontend-vue/package.json` its tarball holds.
 */
async function declaredRanges(
  release: ListedRelease,
  locked: ReadonlyMap<string, string>,
): Promise<Declared> {
  const peers = [...release.peerDependencies].map(
    ([peer, range]): Requirement => ({
      peer,
      range,
      where: "package.json peerDependencies",
      releaseLine: false,
    }),
  );
  if (!locked.has(RENDERER)) return { requirements: peers };
  const frontend = await tarballRequirements(release.tarball);
  return "failure" in frontend
    ? frontend
    : { requirements: [...peers, ...frontend.requirements] };
}

/**
 * Whether `range` admits `version`. A prerelease is ordered among releases, so `1.24.10-next.1` is inside `~1.24.x` and
 * `1.0.0-rc.1` is below `>=1.0.0`; with `releaseLine`, a prerelease counts as the release it leads to, as `ajs-dms build`
 * judges a frontend's range.
 */
const admits = (
  range: string,
  version: string,
  releaseLine: boolean,
): boolean =>
  satisfies(
    releaseLine ? (coerce(version)?.version ?? version) : version,
    range,
    { includePrerelease: true },
  );

async function moduleReport(
  module: Installed,
  listing: Packument | undefined,
  locked: ReadonlyMap<string, string>,
): Promise<string> {
  if (listing === undefined)
    return `${module.from} names "${module.name}", which could not be read from ${registry()}.\n`;
  const version =
    module.recorded ??
    listing.tags.get(module.pick) ??
    (validRange(module.pick) === null
      ? null
      : maxSatisfying([...listing.releases.keys()], module.pick));
  const release = version === null ? undefined : listing.releases.get(version);
  if (version === null || release === undefined)
    return `${module.from} names "${module.name}", which has no release in "${module.pick}" on ${registry()}.\n`;
  const declared = await declaredRanges(release, locked);
  if ("failure" in declared)
    return `The tarball of ${module.name}@${version} ${declared.failure}.\n`;
  return declared.requirements
    .flatMap(({ peer, range, where, releaseLine }) => {
      const at = locked.get(peer);
      return at === undefined ||
        validRange(range) === null ||
        admits(range, at, releaseLine)
        ? []
        : [
            `${ROOT_LOCK} locks "${peer}" at ${at}, outside "${range}", the range ${module.name}@${version} (${module.from}) declares in ${where}.\n  Set "${peer}" in package.json to a version in "${range}", then run \`pnpm install\`.\n`,
          ];
    })
    .join("");
}

/** Whether the repository has a root `pnpm-lock.yaml` and an `antelope.config.ts`. */
export function hasModulePeers(root: string): boolean {
  return (
    existsSync(join(root, ROOT_LOCK)) && existsSync(join(root, PROJECT_CONFIG))
  );
}

/**
 * Fails when the root `pnpm-lock.yaml` locks a direct dependency outside a range an installed module release declares on
 * it: under its `peerDependencies`, or in its `frontend-vue/package.json` `engines["@antelopejs/dms-frontend"]`, the range
 * `ajs-dms build` holds the dashboard's renderer to. The installed release of each `antelope.config.ts` source is the one
 * a build installs: the highest `antelope-lock/` version its range admits, else the newest release on the registry its
 * range, exact version or dist-tag admits. Reads each release's packument from the registry, and its tarball when the
 * root lockfile locks the renderer. Returns what
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
