import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import { isMap, isScalar, parseDocument, type YAMLMap } from "yaml";

import { verifyLayers } from "./verify-layers.ts";

/** The folder a repository's playground lives in; verify installs a fixture project from it. */
const PLAYGROUND = "playground";

const PNPM_LOCK = "pnpm-lock.yaml";
const NPM_LOCK = "package-lock.json";
const MANIFEST = "package.json";
const PNPM_WORKSPACE = "pnpm-workspace.yaml";

/** Lockfiles this check does not compare, which still mean a folder is locked. */
const OTHER_LOCKS = [
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
] as const;

/** The manifest fields both package managers record as a project's direct dependencies. */
export const DIRECT_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
] as const;

/** A JSON or YAML mapping, read with every scalar as its source text; `undefined` when absent or not a mapping. */
export type Mapping = YAMLMap | undefined;

/** Direct dependencies by name, each with every specifier it is declared or locked with across the three fields. */
type Direct = Map<string, Set<string>>;

/** A folder this check reads, relative to the repository root, and the lockfile it holds; `undefined` for a folder verify installs from that holds none. */
export interface InstallFolder {
  folder: string;
  lockfile: typeof PNPM_LOCK | typeof NPM_LOCK | "other" | undefined;
}

/** A lockfile or manifest this check cannot read as a version it knows. */
export class Unreadable extends Error {}

/** Parses a JSON or YAML file whose top level is a mapping; throws `Unreadable` otherwise. */
export function readMapping(path: string): YAMLMap {
  const document = parseDocument(readFileSync(path, "utf8"), {
    schema: "failsafe",
    uniqueKeys: false,
  });
  const { contents } = document;
  if (document.errors.length > 0 || !isMap(contents))
    throw new Unreadable(path);
  return contents;
}

/** The mapping under `key`; `undefined` when absent or not a mapping. */
export function mapping(map: Mapping, key: string): Mapping {
  const value = map?.get(key, true);
  return isMap(value) ? value : undefined;
}

/** The source text of the scalar under `key`; `undefined` when absent or not a scalar. */
export function scalar(map: Mapping, key: string): string | undefined {
  const value = map?.get(key, true);
  return isScalar(value) ? String(value.value) : undefined;
}

/** The scalar keys of a mapping, in order; none when it is absent. */
export function keys(map: Mapping): string[] {
  return (map?.items ?? []).flatMap((pair) =>
    isScalar(pair.key) ? [String(pair.key.value)] : [],
  );
}

/** Reads a project's direct dependencies, with `specifierOf` reading the specifier of one name from its field. */
function directOf(
  node: Mapping,
  specifierOf: (field: Mapping, name: string) => string | undefined,
): Direct {
  const direct: Direct = new Map();
  for (const field of DIRECT_FIELDS) {
    const entries = mapping(node, field);
    for (const name of keys(entries)) {
      const specifier = specifierOf(entries, name);
      if (specifier === undefined) throw new Unreadable(name);
      direct.set(name, new Set([...(direct.get(name) ?? []), specifier]));
    }
  }
  return direct;
}

/** A `package.json` or a `package-lock.json` root entry, where each name maps to its specifier. */
function declared(node: Mapping): Direct {
  return directOf(node, scalar);
}

/** A `pnpm-lock.yaml` importer, where each name maps to its `specifier` and resolved `version`. */
function pnpmLocked(node: Mapping): Direct {
  return directOf(node, (field, name) =>
    scalar(mapping(field, name), "specifier"),
  );
}

function listed(specifiers: Set<string> | undefined): string {
  return specifiers === undefined
    ? "none"
    : [...specifiers].map((specifier) => `"${specifier}"`).join(" or ");
}

/**
 * The names whose specifiers differ between a manifest and what its lockfile records, in either direction. A name counts as
 * present whichever of the three fields records it, and matches when the two sides share a specifier. A name the lockfile
 * records and the manifest declares only as a peer passes, since the package manager may or may not install peers. `skip`
 * names the manifest entries the lockfile may leave out or record with another specifier.
 */
function differences(
  manifest: Mapping,
  locked: Direct,
  skip: (name: string, specifiers: Set<string>) => boolean,
): string[] {
  const wanted = declared(manifest);
  const peers = new Set(keys(mapping(manifest, "peerDependencies")));
  const line = (name: string) =>
    `"${name}": package.json asks for ${listed(wanted.get(name))}, the lockfile has ${listed(locked.get(name))}.`;
  const stale = [...wanted]
    .filter(
      ([name, specifiers]) =>
        ![...(locked.get(name) ?? [])].some((specifier) =>
          specifiers.has(specifier),
        ) && !skip(name, specifiers),
    )
    .map(([name]) => line(name));
  const extra = [...locked.keys()]
    .filter((name) => !wanted.has(name) && !peers.has(name))
    .map(line);
  return [...stale, ...extra].sort();
}

/** Every package name an override selector such as `foo`, `@scope/foo@^1` or `bar@1>foo@2` mentions, its target among them. */
function overrideNames(selector: string): string[] {
  return selector
    .split(">")
    .flatMap((segment) => /^(?:@[^/@]+\/)?[^@]+/u.exec(segment) ?? []);
}

function pnpmDifferences(path: string): string[] {
  const lockfile = readMapping(join(path, PNPM_LOCK));
  if (Number(scalar(lockfile, "lockfileVersion") ?? "0") < 6)
    throw new Unreadable(path);
  const overridden = new Set(
    keys(mapping(lockfile, "overrides")).flatMap(overrideNames),
  );
  const linksLeftOut =
    scalar(mapping(lockfile, "settings"), "excludeLinksFromLockfile") ===
    "true";
  const skip = (name: string, specifiers: Set<string>) =>
    overridden.has(name) ||
    (linksLeftOut &&
      [...specifiers].every((specifier) => specifier.startsWith("link:")));
  const importers = mapping(lockfile, "importers");
  return (importers ? keys(importers) : ["."]).flatMap((importer) => {
    const manifest = join(path, importer, MANIFEST);
    if (!existsSync(manifest)) return [];
    const node = importers ? mapping(importers, importer) : lockfile;
    return differences(readMapping(manifest), pnpmLocked(node), skip).map(
      (line) => `importer "${importer}" ${line}`,
    );
  });
}

function npmDifferences(path: string): string[] {
  const lockfile = readMapping(join(path, NPM_LOCK));
  const rootEntry = mapping(mapping(lockfile, "packages"), "");
  if (
    Number(scalar(lockfile, "lockfileVersion") ?? "0") < 2 ||
    rootEntry === undefined
  )
    throw new Unreadable(path);
  const manifest = join(path, MANIFEST);
  if (!existsSync(manifest)) return [];
  return differences(readMapping(manifest), declared(rootEntry), () => false);
}

function lockfileIn(path: string): InstallFolder["lockfile"] {
  if (existsSync(join(path, PNPM_LOCK))) return PNPM_LOCK;
  if (existsSync(join(path, NPM_LOCK))) return NPM_LOCK;
  return OTHER_LOCKS.some((name) => existsSync(join(path, name)))
    ? "other"
    : undefined;
}

/** Each folder at or under `folder`, `node_modules` and `dist` aside, that holds a lockfile. */
function lockedFolders(root: string, folder: string): InstallFolder[] {
  const path = join(root, folder);
  if (!existsSync(path)) return [];
  const lockfile = lockfileIn(path);
  return [
    ...(lockfile === undefined ? [] : [{ folder, lockfile }]),
    ...readdirSync(path, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name !== "node_modules" &&
          entry.name !== "dist",
      )
      .flatMap((entry) => lockedFolders(root, `${folder}/${entry.name}`)),
  ];
}

/** Whether a `package.json` declares a direct dependency; `false` when it is missing or cannot be read, so this check cannot tell. */
function hasDependencies(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    const manifest = readMapping(path);
    return DIRECT_FIELDS.some(
      (field) => keys(mapping(manifest, field)).length > 0,
    );
  } catch (error) {
    if (error instanceof Unreadable) return false;
    throw error;
  }
}

/**
 * The folders this check reads, when a layer exists: each folder under a layer, `node_modules` and `dist` aside, and the
 * root `playground`, that holds a lockfile; and each layer's `playground` and the root `playground`, the folders verify
 * installs from, when its `package.json` has dependencies and it holds no lockfile.
 */
export function verifyInstallFolders(root: string): InstallFolder[] {
  const layers = verifyLayers(root);
  if (layers.length === 0) return [];
  const playgrounds = [
    ...layers.map((layer) => `${layer}/${PLAYGROUND}`),
    PLAYGROUND,
  ];
  const rootPlayground = lockfileIn(join(root, PLAYGROUND));
  return [
    ...layers.flatMap((layer) => lockedFolders(root, layer)),
    ...(rootPlayground === undefined
      ? []
      : [{ folder: PLAYGROUND, lockfile: rootPlayground }]),
    ...playgrounds
      .filter(
        (folder) =>
          lockfileIn(join(root, folder)) === undefined &&
          hasDependencies(join(root, folder, MANIFEST)),
      )
      .map((folder) => ({ folder, lockfile: undefined })),
  ];
}

/** The folders above `folder`, nearest first, up to the repository root. */
function ancestors(folder: string): string[] {
  const parent = posix.dirname(folder);
  return parent === folder ? [] : [parent, ...ancestors(parent)];
}

/** Whether a manifest declares workspaces, or cannot be read and so might. */
function declaresWorkspaces(path: string): boolean {
  try {
    return existsSync(path) && readMapping(path).has("workspaces");
  } catch (error) {
    if (error instanceof Unreadable) return true;
    throw error;
  }
}

/**
 * Whether a folder above `folder` holds a workspace that may list it, a `pnpm-workspace.yaml` or a `package.json` with
 * `workspaces`: its membership then follows patterns this check does not evaluate, and that workspace's lockfile may hold it.
 */
function inWorkspace(root: string, folder: string): boolean {
  return ancestors(folder).some(
    (above) =>
      existsSync(join(root, above, PNPM_WORKSPACE)) ||
      declaresWorkspaces(join(root, above, MANIFEST)),
  );
}

function fixCommand(
  root: string,
  folder: string,
  lockfile: typeof PNPM_LOCK | typeof NPM_LOCK,
): string {
  if (lockfile === NPM_LOCK)
    return `npm install --package-lock-only --prefix ${folder}`;
  return existsSync(join(root, folder, PNPM_WORKSPACE))
    ? `pnpm install --dir ${folder} --lockfile-only`
    : `pnpm install --dir ${folder} --ignore-workspace --lockfile-only`;
}

function unlocked(root: string, folder: string): string {
  if (inWorkspace(root, folder)) return "";
  const manager = ancestors(folder).some((above) =>
    existsSync(join(root, above, NPM_LOCK)),
  )
    ? NPM_LOCK
    : PNPM_LOCK;
  return `${folder}/${MANIFEST} has dependencies and no lockfile: run \`${fixCommand(root, folder, manager)}\`.\n`;
}

function checkFolder(
  root: string,
  { folder, lockfile }: InstallFolder,
): string {
  if (lockfile === "other") return "";
  try {
    if (lockfile === undefined) return unlocked(root, folder);
    const path = join(root, folder);
    const found =
      lockfile === PNPM_LOCK ? pnpmDifferences(path) : npmDifferences(path);
    return found.length === 0
      ? ""
      : `${folder}/${lockfile} does not match ${folder}/${MANIFEST}: run \`${fixCommand(root, folder, lockfile)}\`.\n${found.map((line) => `  ${line}\n`).join("")}`;
  } catch (error) {
    if (error instanceof Unreadable)
      return `${folder}/${lockfile ?? MANIFEST}: could not read it, or a ${MANIFEST} it locks, as a version this check knows.\n`;
    throw error;
  }
}

/**
 * Compares, in code, the direct dependencies each lockfile records with the `package.json` files it locks, and fails on a
 * difference in either direction. A `pnpm-lock.yaml` is compared importer by importer, for each importer it lists that has a
 * `package.json` on disk; a `package-lock.json` by its root entry. Only `dependencies`, `devDependencies` and
 * `optionalDependencies` are compared, by name and specifier: a name counts as present whichever of the three fields records
 * it, and specifiers such as `catalog:` or `workspace:^` compare as written. A name the lockfile records that `package.json`
 * declares only in `peerDependencies` passes. A `package.json` name that an override selector in the `pnpm-lock.yaml`
 * mentions, or a `link:` one the lockfile leaves out under `excludeLinksFromLockfile`, is not compared. A missing lockfile fails only in a layer's
 * `playground` or the root `playground` whose `package.json` has dependencies, unless a folder above it holds a workspace.
 *
 * It spawns no package manager, writes no file and fetches nothing. It does not check workspace membership, overrides,
 * settings, catalogs, `.npmrc` or user configuration, resolved versions, integrity hashes, transitive entries, npm workspace
 * members, or `yarn.lock` and `bun.lock`: verify's own frozen install still rejects a lockfile stale there. Returns what
 * failed, empty when every lockfile matches.
 */
export function checkLockfiles(root: string): string {
  return verifyInstallFolders(root)
    .map((install) => checkFolder(root, install))
    .join("");
}
