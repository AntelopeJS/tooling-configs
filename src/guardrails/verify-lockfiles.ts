import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, matchesGlob, posix } from "node:path";
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from "yaml";

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

/** The manifest fields pnpm records as an importer's specifiers. */
const PNPM_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
] as const;

/** The manifest fields npm records in the root entry of `package-lock.json`. */
const NPM_FIELDS = [...PNPM_FIELDS, "peerDependencies"] as const;

/** The first pnpm major that reads overrides only from `pnpm-workspace.yaml`, never from the `pnpm` field of `package.json`. */
const PNPM_WITHOUT_MANIFEST_SETTINGS = 11;

/** Lockfile settings pnpm's frozen install compares with its configuration, and their defaults. */
const PNPM_SETTINGS = {
  autoInstallPeers: "true",
  excludeLinksFromLockfile: "false",
} as const;

/** A JSON or YAML mapping, read with every scalar as its source text; `undefined` when absent or not a mapping. */
type Mapping = YAMLMap | undefined;

/** What a lockfile records and what its manifests ask for, keyed by a readable path such as `importer "." dependencies "zod"`. */
type Entries = Map<string, string>;

/** The two sides a lockfile check compares. */
interface Comparison {
  expected: Entries;
  locked: Entries;
}

/** A folder verify installs from, relative to the repository root, and the lockfile it holds, if any. */
export interface InstallFolder {
  folder: string;
  lockfile: typeof PNPM_LOCK | typeof NPM_LOCK | "other" | undefined;
}

class Unreadable extends Error {}

/** The value an importer key holds on the side that has it. */
const IMPORTER = "importer";

/** Parses a JSON or YAML file whose top level is a mapping; throws `Unreadable` otherwise. */
function readMapping(path: string): YAMLMap {
  const document = parseDocument(readFileSync(path, "utf8"), {
    schema: "failsafe",
    uniqueKeys: false,
  });
  const { contents } = document;
  if (document.errors.length > 0 || !isMap(contents))
    throw new Unreadable(path);
  return contents;
}

function readOptional(path: string): Mapping {
  return existsSync(path) ? readMapping(path) : undefined;
}

function mapping(map: Mapping, key: string): Mapping {
  const value = map?.get(key, true);
  return isMap(value) ? value : undefined;
}

function scalar(map: Mapping, key: string): string | undefined {
  const value = map?.get(key, true);
  return isScalar(value) ? String(value.value) : undefined;
}

function sequence(map: Mapping, key: string): string[] {
  const value = map?.get(key, true);
  if (!isSeq(value)) return [];
  return value.items.flatMap((item) =>
    isScalar(item) ? [String(item.value)] : [],
  );
}

function keys(map: Mapping): string[] {
  return (map?.items ?? []).flatMap((pair) =>
    isScalar(pair.key) ? [String(pair.key.value)] : [],
  );
}

function strings(map: Mapping): Map<string, string> {
  return new Map(
    keys(map).flatMap((key) => {
      const value = scalar(map, key);
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

/** Whether a `package.json` needs a lockfile: it has dependencies, or it cannot be read and so might. */
function needsLockfile(path: string): boolean {
  try {
    const manifest = readMapping(path);
    return PNPM_FIELDS.some(
      (field) => keys(mapping(manifest, field)).length > 0,
    );
  } catch (error) {
    if (error instanceof Unreadable) return true;
    throw error;
  }
}

function lockfileOf(names: Set<string>): InstallFolder["lockfile"] {
  if (names.has(PNPM_LOCK)) return PNPM_LOCK;
  if (names.has(NPM_LOCK)) return NPM_LOCK;
  return OTHER_LOCKS.some((name) => names.has(name)) ? "other" : undefined;
}

function scan(root: string, folder: string, deep: boolean): InstallFolder[] {
  const path = join(root, folder);
  if (!existsSync(path)) return [];
  const listing = readdirSync(path, { withFileTypes: true });
  const names = new Set(
    listing.filter((entry) => entry.isFile()).map((entry) => entry.name),
  );
  const lockfile = lockfileOf(names);
  const here: InstallFolder[] =
    lockfile !== undefined ||
    (names.has(MANIFEST) && needsLockfile(join(path, MANIFEST)))
      ? [{ folder, lockfile }]
      : [];
  const below = deep
    ? listing
        .filter(
          (entry) =>
            entry.isDirectory() &&
            entry.name !== "node_modules" &&
            entry.name !== "dist",
        )
        .flatMap((entry) => scan(root, `${folder}/${entry.name}`, deep))
    : [];
  return [...here, ...below];
}

function workspacePatterns(workspace: Mapping): string[] {
  return sequence(workspace, "packages");
}

function normalizedPattern(pattern: string): string {
  const trimmed = pattern.replace(/^\.\//u, "").replace(/\/+$/u, "");
  return trimmed === "" ? "." : trimmed;
}

/** Whether a pnpm workspace with these `packages` patterns lists `member`, a path relative to the workspace root. */
function listsMember(patterns: string[], member: string): boolean {
  let listed = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const glob = normalizedPattern(negated ? pattern.slice(1) : pattern);
    if (glob === member || matchesGlob(member, glob)) listed = !negated;
  }
  return listed;
}

/** Whether a `pnpm-workspace.yaml` in a folder above `folder`, up to the repository root, lists it, so that workspace's lockfile holds its dependencies. */
function inEnclosingWorkspace(root: string, folder: string): boolean {
  let above = posix.dirname(folder);
  while (true) {
    const workspace = readOptional(join(root, above, PNPM_WORKSPACE));
    if (
      workspace !== undefined &&
      listsMember(
        workspacePatterns(workspace),
        posix.relative(above === "." ? "" : above, folder),
      )
    )
      return true;
    if (above === ".") return false;
    above = posix.dirname(above);
  }
}

/**
 * Every folder verify installs from, when a layer exists: each folder under a layer, `node_modules` and `dist` aside, and the
 * root `playground`, that holds a lockfile or a `package.json` with dependencies.
 */
export function verifyInstallFolders(root: string): InstallFolder[] {
  const layers = verifyLayers(root);
  if (layers.length === 0) return [];
  return [
    ...layers.flatMap((layer) => scan(root, layer, true)),
    ...scan(root, PLAYGROUND, false),
  ];
}

function pnpmMajor(manifest: Mapping): number | undefined {
  const match = /^pnpm@(\d+)/u.exec(scalar(manifest, "packageManager") ?? "");
  return match ? Number(match[1]) : undefined;
}

function pnpmMembers(path: string, patterns: string[]): string[] {
  const members: string[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(join(path, relative), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      const member = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (
        existsSync(join(path, member, MANIFEST)) &&
        listsMember(patterns, member)
      )
        members.push(member);
      walk(member);
    }
  };
  if (patterns.length > 0) walk("");
  return [".", ...members];
}

function expectedSpecifiers(
  importer: string,
  manifest: Mapping,
  settings: Map<string, string>,
): Entries {
  const expected: Entries = new Map();
  const declared = new Set<string>();
  for (const field of PNPM_FIELDS)
    for (const [name, specifier] of strings(mapping(manifest, field))) {
      declared.add(name);
      if (
        settings.get("excludeLinksFromLockfile") === "true" &&
        specifier.startsWith("link:")
      )
        continue;
      expected.set(`importer "${importer}" ${field} "${name}"`, specifier);
    }
  if (settings.get("autoInstallPeers") === "true")
    for (const [name, specifier] of strings(
      mapping(manifest, "peerDependencies"),
    ))
      if (!declared.has(name))
        expected.set(
          `importer "${importer}" dependencies "${name}"`,
          specifier,
        );
  return expected;
}

function lockedSpecifiers(importer: string, node: Mapping): Entries {
  const locked: Entries = new Map();
  for (const field of PNPM_FIELDS)
    for (const name of keys(mapping(node, field))) {
      const specifier = scalar(
        mapping(mapping(node, field), name),
        "specifier",
      );
      if (specifier === undefined) throw new Unreadable(name);
      locked.set(`importer "${importer}" ${field} "${name}"`, specifier);
    }
  return locked;
}

function expectedOverrides(
  manifest: Mapping,
  workspace: Mapping,
  ownWorkspace: boolean,
): Entries {
  const fromManifest =
    (pnpmMajor(manifest) ?? 0) < PNPM_WITHOUT_MANIFEST_SETTINGS
      ? strings(mapping(mapping(manifest, "pnpm"), "overrides"))
      : new Map<string, string>();
  const fromWorkspace = ownWorkspace
    ? strings(mapping(workspace, "overrides"))
    : new Map<string, string>();
  const declared = new Map(
    NPM_FIELDS.flatMap((field) => [...strings(mapping(manifest, field))]),
  );
  return new Map(
    [...fromManifest, ...fromWorkspace].map(([selector, value]) => [
      `overrides "${selector}"`,
      value.startsWith("$") ? (declared.get(value.slice(1)) ?? value) : value,
    ]),
  );
}

function expectedSettings(workspace: Mapping): Map<string, string> {
  return new Map(
    Object.entries(PNPM_SETTINGS).map(([name, fallback]) => [
      name,
      scalar(workspace, name) ?? fallback,
    ]),
  );
}

function pnpmEntries(path: string): Comparison {
  const lockfile = readMapping(join(path, PNPM_LOCK));
  if (Number(scalar(lockfile, "lockfileVersion") ?? "0") < 6)
    throw new Unreadable(path);
  const manifest = readMapping(join(path, MANIFEST));
  const workspace = readOptional(join(path, PNPM_WORKSPACE));
  const patterns = workspacePatterns(workspace);
  const settings = expectedSettings(workspace);
  const importers = mapping(lockfile, "importers");
  const expected: Entries = new Map([
    ...expectedOverrides(manifest, workspace, patterns.length > 0),
    ...[...settings].map(([name, value]): [string, string] => [
      `settings "${name}"`,
      value,
    ]),
  ]);
  for (const member of pnpmMembers(path, patterns)) {
    expected.set(`importer "${member}"`, IMPORTER);
    const memberManifest =
      member === "." ? manifest : readMapping(join(path, member, MANIFEST));
    for (const entry of expectedSpecifiers(member, memberManifest, settings))
      expected.set(...entry);
  }
  const settingsNode = mapping(lockfile, "settings");
  const locked: Entries = new Map([
    ...[...strings(mapping(lockfile, "overrides"))].map(
      ([selector, value]): [string, string] => [
        `overrides "${selector}"`,
        value,
      ],
    ),
    ...Object.entries(PNPM_SETTINGS).map(
      ([name, fallback]): [string, string] => [
        `settings "${name}"`,
        scalar(settingsNode, name) ?? fallback,
      ],
    ),
  ]);
  for (const importer of importers ? keys(importers) : ["."]) {
    locked.set(`importer "${importer}"`, IMPORTER);
    const node = importers ? mapping(importers, importer) : lockfile;
    for (const entry of lockedSpecifiers(importer, node)) locked.set(...entry);
  }
  return { expected, locked };
}

function npmFields(node: Mapping): Entries {
  const fields = new Map(
    NPM_FIELDS.map((field) => [field, strings(mapping(node, field))]),
  );
  return new Map(
    [...fields].flatMap(([field, specifiers]) =>
      [...specifiers]
        .filter(
          ([name]) =>
            field !== "dependencies" ||
            !fields.get("optionalDependencies")?.has(name),
        )
        .map(([name, specifier]): [string, string] => [
          `${field} "${name}"`,
          specifier,
        ]),
    ),
  );
}

function npmEntries(path: string): Comparison {
  const lockfile = readMapping(join(path, NPM_LOCK));
  const rootEntry = mapping(mapping(lockfile, "packages"), "");
  if (
    Number(scalar(lockfile, "lockfileVersion") ?? "0") < 2 ||
    rootEntry === undefined
  )
    throw new Unreadable(path);
  return {
    expected: npmFields(readMapping(join(path, MANIFEST))),
    locked: npmFields(rootEntry),
  };
}

function describe(value: string | undefined): string {
  return value === undefined ? "none" : `"${value}"`;
}

function mismatch(key: string, expected?: string, locked?: string): string {
  if (expected === IMPORTER)
    return `  ${key}: a workspace package the lockfile does not list.\n`;
  if (locked === IMPORTER)
    return `  ${key}: the lockfile lists it, and no workspace package matches it.\n`;
  return `  ${key}: the manifests ask for ${describe(expected)}, the lockfile has ${describe(locked)}.\n`;
}

function mismatches(expected: Entries, locked: Entries): string[] {
  const all = new Set([...expected.keys(), ...locked.keys()]);
  return [...all]
    .filter((key) => expected.get(key) !== locked.get(key))
    .sort()
    .map((key) => mismatch(key, expected.get(key), locked.get(key)));
}

function fixCommand(root: string, { folder, lockfile }: InstallFolder): string {
  if (lockfile === NPM_LOCK)
    return `npm install --package-lock-only --prefix ${folder}`;
  return existsSync(join(root, folder, PNPM_WORKSPACE))
    ? `pnpm install --dir ${folder} --lockfile-only`
    : `pnpm install --dir ${folder} --ignore-workspace --lockfile-only`;
}

function compareFolder(
  root: string,
  install: InstallFolder & { lockfile: typeof PNPM_LOCK | typeof NPM_LOCK },
): string {
  const { folder, lockfile } = install;
  const path = join(root, folder);
  if (!existsSync(join(path, MANIFEST)))
    return `${folder}/${lockfile} has no ${MANIFEST} beside it.\n`;
  const { expected, locked } =
    lockfile === PNPM_LOCK ? pnpmEntries(path) : npmEntries(path);
  const found = mismatches(expected, locked);
  return found.length === 0
    ? ""
    : `${folder}/${lockfile} does not match ${folder}/${MANIFEST}: run \`${fixCommand(root, install)}\`.\n${found.join("")}`;
}

function checkFolder(root: string, install: InstallFolder): string {
  const { folder, lockfile } = install;
  if (lockfile === "other") return "";
  try {
    if (lockfile !== undefined)
      return compareFolder(root, { folder, lockfile });
    return inEnclosingWorkspace(root, folder)
      ? ""
      : `${folder}/${MANIFEST} has dependencies and no lockfile: run \`${fixCommand(root, install)}\`.\n`;
  } catch (error) {
    if (error instanceof Unreadable)
      return `${folder}/${lockfile ?? MANIFEST}: could not read it, a ${MANIFEST} or a ${PNPM_WORKSPACE} it depends on, as a version this check knows.\n`;
    throw error;
  }
}

/**
 * Compares, in code, each lockfile verify installs from with the manifests it was made from, the way a frozen install does,
 * and fails on any difference in either direction. For a `pnpm-lock.yaml`: the importers, which are `.` plus the members a
 * `pnpm-workspace.yaml` in the same folder lists; each importer's `dependencies`, `devDependencies` and `optionalDependencies`
 * specifiers, plus the `peerDependencies` pnpm adds when `autoInstallPeers` is on; `overrides`, from the `pnpm` field of
 * `package.json` before pnpm 11 and from that `pnpm-workspace.yaml`, with `$name` references resolved; and the
 * `autoInstallPeers` and `excludeLinksFromLockfile` settings that file sets. For a `package-lock.json`: the root entry's
 * `dependencies`, `devDependencies`, `optionalDependencies` and `peerDependencies`. A folder whose `package.json` has
 * dependencies and no lockfile fails, unless a `pnpm-workspace.yaml` above it lists it.
 *
 * It spawns no package manager, writes no file and fetches nothing. It does not check the resolved versions, integrity
 * hashes or transitive entries, `.npmrc` or user configuration, catalogs, patches or npm workspaces: verify's own frozen
 * install still rejects those. Returns what failed, empty when every lockfile matches.
 */
export function checkLockfiles(root: string): string {
  return verifyInstallFolders(root)
    .map((install) => checkFolder(root, install))
    .join("");
}
