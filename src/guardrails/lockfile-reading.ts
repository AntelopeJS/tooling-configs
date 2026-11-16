import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { isMap, isScalar, parseDocument, type YAMLMap } from "yaml";

const PNPM_LOCK = "pnpm-lock.yaml";
const NPM_LOCK = "package-lock.json";
const MANIFEST = "package.json";
const PNPM_WORKSPACE = "pnpm-workspace.yaml";

/** Lockfiles other than pnpm's and npm's, which still mean a folder is locked. */
const OTHER_LOCKS = [
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
] as const;

/** A JSON or YAML mapping, read with every scalar as its source text; `undefined` when absent or not a mapping. */
export type Mapping = YAMLMap | undefined;

/** A lockfile or manifest that cannot be read as a version this module knows. */
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

function lockfileIn(
  path: string,
): typeof PNPM_LOCK | typeof NPM_LOCK | "other" | undefined {
  if (existsSync(join(path, PNPM_LOCK))) return PNPM_LOCK;
  if (existsSync(join(path, NPM_LOCK))) return NPM_LOCK;
  return OTHER_LOCKS.some((name) => existsSync(join(path, name)))
    ? "other"
    : undefined;
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

/** Whether a `pnpm-workspace.yaml` lists `packages`, or cannot be read and so might; an empty one, or one without them, holds its own folder only. */
function declaresPackages(path: string): boolean {
  if (!existsSync(path)) return false;
  const document = parseDocument(readFileSync(path, "utf8"));
  if (document.errors.length > 0) return true;
  const { contents } = document;
  if (contents === null || (isScalar(contents) && contents.value === null))
    return false;
  return !isMap(contents) || contents.has("packages");
}

/**
 * Whether a folder above `folder` holds a workspace that may list it, a `pnpm-workspace.yaml` with `packages` or a
 * `package.json` with `workspaces`: its membership then follows patterns this module does not evaluate, and that workspace's
 * lockfile may hold it.
 */
export function inWorkspace(root: string, folder: string): boolean {
  return ancestors(folder).some(
    (above) =>
      declaresPackages(join(root, above, PNPM_WORKSPACE)) ||
      declaresWorkspaces(join(root, above, MANIFEST)),
  );
}

/** The lockfile an install writes in a folder that holds none: `package-lock.json` when a folder above holds one, `pnpm-lock.yaml` otherwise. */
function unlockedLockfile(
  root: string,
  folder: string,
): typeof PNPM_LOCK | typeof NPM_LOCK {
  return ancestors(folder).some((above) =>
    existsSync(join(root, above, NPM_LOCK)),
  )
    ? NPM_LOCK
    : PNPM_LOCK;
}

/** Whether pnpm installs `folder`: it holds a `pnpm-lock.yaml`, or no lockfile and no folder above it holds a `package-lock.json`. */
export function installsWithPnpm(root: string, folder: string): boolean {
  return (
    (lockfileIn(join(root, folder)) ?? unlockedLockfile(root, folder)) ===
    PNPM_LOCK
  );
}
