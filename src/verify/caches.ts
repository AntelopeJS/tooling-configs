import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, sep } from "node:path";

import { isObject, parseJson } from "../garden/json.ts";
import { removeTree } from "./workspace.ts";

/** Where `ajs` installs the modules of a project that names no other `cacheFolder`. */
const PROJECT_CACHE = join(".antelope", "cache");

const MANIFEST = "manifest.json";

/** Stands in a kept cache for the path of the project cache it was kept from, which pnpm 10 and 11 write into the `NODE_PATH` of each `.bin` shim. */
const KEPT_CACHE = `${sep}@antelopejs-verify-kept-cache@${sep}`;

/** Where `ajs` keeps a project's lock records, one folder per `<package>@<version>`. */
const LOCK_FOLDER = "antelope-lock";

/** How many milliseconds the harness waits at most for the file system clock to pass an install. */
const CLOCK_ATTEMPTS = 100;

/** A start time later than every command's, for a module the harness first sees outside a command: any lock record it has counts as one `ajs` installed it from. */
const UNKNOWN_START = 2n ** 63n;

/** A version `ajs` records for a registry package; a git module records `git:<branch>:<commit>`. */
const REGISTRY_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/;

/** A module `ajs` installed into a project cache: its version, when the folder that holds it was created, and the last modification time any of its files may carry, all in nanoseconds. */
interface Installed {
  version: string;
  born: bigint;
  bound: bigint;
}

/** A project whose module cache the harness follows: each registry module as first seen, each git module seen, and the first reason the cache is not exactly what a fresh `ajs` install gives. */
interface Project {
  installed: Map<string, Installed>;
  git: Set<string>;
  refused?: string;
}

/** When the folder at `path` was created, which tells apart the folders created one after another there even when the file system reuses the inode; `0n` when the file system does not record it. */
function bornAt(path: string): bigint {
  try {
    return lstatSync(path, { bigint: true }).birthtimeNs;
  } catch {
    return 0n;
  }
}

/** Whether `project` held the lock record of `name@version` when a command that started at `start` began; `ajs` writes a record only after an install that used none. */
function pinned(
  project: string,
  name: string,
  version: string,
  start: bigint,
): boolean {
  try {
    const record = join(project, LOCK_FOLDER, `${name}@${version}`);
    return lstatSync(record, { bigint: true }).mtimeNs <= start;
  } catch {
    return false;
  }
}

function names(folder: string): string[] {
  try {
    return readdirSync(folder).filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
}

/** Why a module the harness recorded as `known` is no longer that install, now that the manifest lists `version` in a folder created at `born`. */
function reinstalled(
  name: string,
  known: Installed,
  version: string,
  born: bigint,
): string | undefined {
  if (known.version !== version)
    return `${name} changed from ${known.version} to ${version} after ajs installed it`;
  if (born !== known.born)
    return `${name} was created again after ajs installed ${name}@${version}`;
  return undefined;
}

/** Every entry under `root` but those `skip` names and what they hold, by its path relative to `root`, with its modification time; symbolic links are listed, not followed. */
function* entries(
  root: string,
  skip: (path: string) => boolean = () => false,
  prefix = "",
): Generator<{ path: string; mtime: bigint; directory: boolean }> {
  for (const entry of readdirSync(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = join(prefix, entry.name);
    if (skip(path)) continue;
    const directory = entry.isDirectory();
    yield {
      path,
      mtime: lstatSync(join(root, path), { bigint: true }).mtimeNs,
      directory,
    };
    if (directory) yield* entries(root, skip, path);
  }
}

/** Whether a project's antelope config (antelope.json or antelope.config.*) mentions `cacheFolder`, so `ajs` may install somewhere other than `.antelope/cache`. */
function namesCacheFolder(project: string): boolean {
  try {
    return readdirSync(project)
      .filter((name) => /^antelope(\.config)?\.[cm]?[jt]s(on)?$/.test(name))
      .some((name) =>
        /\bcacheFolder\b/.test(readFileSync(join(project, name), "utf8")),
      );
  } catch {
    return false;
  }
}

/** The path a module installed into `cache` finds it at, with its symbolic links resolved as the working directory of `pnpm` resolves them, ending with a separator. */
function cachePath(cache: string): string {
  return join(realpathSync(dirname(cache)), basename(cache)) + sep;
}

/** Replaces each of `from`, in order, by `to` in every `.bin` shim under `folder`. */
function retarget(folder: string, from: string[], to: string): void {
  for (const { path, directory } of entries(folder)) {
    if (directory || basename(dirname(path)) !== ".bin") continue;
    const file = join(folder, path);
    if (!lstatSync(file).isFile()) continue;
    const text = readFileSync(file, "utf8");
    const shim = from.reduce(
      (current, old) => current.replaceAll(old, () => to),
      text,
    );
    if (shim !== text) writeFileSync(file, shim);
  }
}

/**
 * Copies `source` into a staging entry next to `target`, replaces each of
 * `from` by `to` in its `.bin` shims, and renames it onto `target`, so a
 * reader sees all of the copy or none of it. A failed copy, a deleted source
 * or a `target` another writer filled first leaves `target` as it was. With
 * `only`, the copy leaves out every other module's folder and its manifest
 * lists those modules alone.
 */
function publish(
  source: string,
  target: string,
  from: string[],
  to: string,
  only?: { modules: [string, string][]; left: string[] },
): void {
  const staging = join(
    dirname(target),
    `.staging-${randomBytes(6).toString("hex")}`,
  );
  try {
    cpSync(source, staging, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      filter: (path) =>
        only === undefined ||
        !only.left.some((name) => within(join(source, name), path)),
    });
    if (only !== undefined)
      writeFileSync(
        join(staging, MANIFEST),
        JSON.stringify(Object.fromEntries(only.modules)),
      );
    retarget(staging, from, to);
    renameSync(staging, target);
  } catch {
    return;
  } finally {
    removeTree(staging);
  }
}

/** Why a registry module the project followed is no longer among `modules`, or `undefined` when each still is. */
function departure(
  state: Project,
  modules: [string, string][],
): string | undefined {
  const listed = new Set(modules.map(([name]) => name));
  for (const [name, known] of state.installed)
    if (!listed.has(name))
      return `${name} left ${MANIFEST} after ajs installed ${name}@${known.version}`;
  return undefined;
}

/** Whether `name`, listed at `version`, is a git module `state` does not follow; one seen for the first time joins `added`. */
function recordGit(
  state: Project,
  name: string,
  version: string,
  added: string[],
): boolean {
  if (state.installed.has(name) || REGISTRY_VERSION.test(version)) return false;
  if (!state.git.has(name)) added.push(`${name}@${version}`);
  state.git.add(name);
  return true;
}

/** Whether `path` is `folder` or lies under it. */
function within(folder: string, path: string): boolean {
  return path === folder || path.startsWith(`${folder}${sep}`);
}

/** The manifest `ajs` writes each time it finishes installing a module: its modification time and each module's version, sorted by module. */
function manifestOf(
  cache: string,
): { mtime: bigint; modules: [string, string][] } | undefined {
  try {
    const file = join(cache, MANIFEST);
    const manifest = parseJson(readFileSync(file, "utf8"));
    if (!isObject(manifest)) return undefined;
    const modules = Object.entries(manifest)
      .map(([name, version]): [string, string] => [name, String(version)])
      .sort(([left], [right]) => (left < right ? -1 : 1));
    return { mtime: lstatSync(file, { bigint: true }).mtimeNs, modules };
  } catch {
    return undefined;
  }
}

/**
 * Why `cache` is not exactly what `ajs` installed, or `undefined` when it is.
 * Each file of a module must be no newer than the module's bound. Outside the
 * modules, `ajs` writes only the manifest and the folders that hold the
 * modules, which must be no newer than the manifest. Entries under the
 * folders in `left`, which the kept copy leaves out, are not checked.
 */
function changeIn(
  cache: string,
  installed: Map<string, Installed>,
  manifest: bigint,
  left: string[],
): string | undefined {
  const modules = [...installed].map(([name, module]) => ({
    folder: join(name),
    label: `${name}@${module.version}`,
    bound: module.bound,
  }));
  try {
    for (const { path, mtime, directory } of entries(cache, (path) =>
      left.includes(path),
    )) {
      if (path === MANIFEST) continue;
      const owner = modules.find(({ folder }) => within(folder, path));
      if (owner === undefined) {
        if (!directory) return `${path} belongs to no installed module`;
        if (mtime > manifest)
          return `${path} changed after ajs wrote ${MANIFEST}`;
      } else if (mtime > owner.bound) {
        return `${path} changed after ajs installed ${owner.label}`;
      }
    }
  } catch (error) {
    return `it could not be read: ${error instanceof Error ? error.message : String(error)}`;
  }
  return undefined;
}

/**
 * The module caches of the projects one journey creates, and the run's kept
 * copies of them in `store`. Kept copies are never written, so journeys of
 * one run can copy them at once.
 *
 * Only a cache exactly as a fresh `ajs` install leaves it is kept. `ajs`
 * writes a registry module's files, then records its version in
 * `manifest.json`, so the manifest's modification time when the harness first
 * sees the module bounds every file of it. A file modified later, a module
 * whose version or folder changes after that, a module `ajs` installed from a
 * lock record the project held before the command, and two modules that
 * first appear after one command that is not `ajs`, which may have edited the
 * first before installing the second, each keep the cache out of the store. A
 * git module, which `ajs` updates in place and builds with the project's own
 * install command, is never followed nor kept: the copy holds the cache's
 * registry modules alone.
 */
export class ProjectCaches {
  private readonly store: string;
  private readonly projects = new Map<string, Project>();

  constructor(store: string) {
    this.store = store;
  }

  /** Gives a project that has installed no module yet a copy of the largest kept cache, so `ajs` reuses the packages an earlier journey installed instead of packing and installing them again. A project whose antelope config names its own `cacheFolder` gets no copy, since `ajs` would not read `.antelope/cache`. */
  seed(project: string): void {
    const state: Project = { installed: new Map(), git: new Set() };
    this.projects.set(project, state);
    if (namesCacheFolder(project)) return;
    const cache = join(project, PROJECT_CACHE);
    if ((manifestOf(cache)?.modules.length ?? 0) > 0) {
      this.observe();
      return;
    }
    let largest: { folder: string; size: number } | undefined;
    for (const name of names(this.store)) {
      const folder = join(this.store, name);
      const size = manifestOf(folder)?.modules.length ?? 0;
      if (size > (largest?.size ?? 0)) largest = { folder, size };
    }
    if (largest === undefined) return;
    mkdirSync(dirname(cache), { recursive: true });
    publish(largest.folder, cache, [KEPT_CACHE], cachePath(cache));
    const copied = manifestOf(cache);
    if (copied === undefined) return;
    let bound = copied.mtime;
    try {
      for (const { mtime } of entries(cache)) if (mtime > bound) bound = mtime;
    } catch {
      return;
    }
    for (const [name, version] of copied.modules)
      state.installed.set(name, {
        version,
        born: bornAt(join(cache, name)),
        bound,
      });
    this.passClock(bound);
  }

  /** Every project seeded so far, so a copy of a folder that holds some can seed its own. */
  seeded(): string[] {
    return [...this.projects.keys()];
  }

  /**
   * Records the bound of each registry module that appeared in a project's manifest
   * since the last call, and refuses the cache of a project whose recorded
   * module left the manifest, changed version or sits in a new folder. A
   * module that appeared with a lock record no newer than `start`, the start
   * of the command that just ended, was installed from that record. After a
   * command that is not `ajs`, `ajs` may not be alone between two installs, so a
   * project whose manifest gained more than one module is refused.
   */
  private observe(start = UNKNOWN_START, ajs = true): void {
    let latest = -1n;
    for (const [project, state] of this.projects) {
      const cache = join(project, PROJECT_CACHE);
      const manifest = manifestOf(cache);
      if (manifest === undefined) continue;
      const added: string[] = [];
      state.refused ??= departure(state, manifest.modules);
      for (const [name, version] of manifest.modules) {
        const born = bornAt(join(cache, name));
        const known = state.installed.get(name);
        if (recordGit(state, name, version, added)) continue;
        if (known === undefined) {
          added.push(`${name}@${version}`);
          if (state.git.has(name))
            state.refused ??= `${name} changed from a git module to ${version} after ajs installed it`;
          state.installed.set(name, { version, born, bound: manifest.mtime });
          if (manifest.mtime > latest) latest = manifest.mtime;
          if (pinned(project, name, version, start))
            state.refused ??= `ajs installed ${name}@${version} from the project's lock record`;
        } else {
          state.refused ??= reinstalled(name, known, version, born);
        }
      }
      if (!ajs && added.length > 1)
        state.refused ??= `${added.join(" and ")} appeared in one command that is not ajs, which may have changed one of them before ajs installed the next`;
    }
    if (latest >= 0n) this.passClock(latest);
  }

  /** Observes the project caches once a command or an app start has ended, and returns its result. Its `folder` is the step folder the harness created as it began, so a lock record no newer than that folder was there before the command. `ajs` tells whether only `ajs` ran, as in `ajs` commands and app starts, or a command that may also run other programs. */
  observed<Result extends { folder: string }>(
    result: Result,
    ajs: boolean,
  ): Result {
    this.observe(bornAt(result.folder) || UNKNOWN_START, ajs);
    return result;
  }

  /**
   * Returns once the file system clock has moved past `time`, so a file the
   * journey writes from now on is newer than a bound of `time`. The clock
   * advances in ticks of a few milliseconds, and a write within the tick of
   * the bound would carry the bound's time.
   */
  private passClock(time: bigint): void {
    const probe = join(this.store, `.clock-${randomBytes(6).toString("hex")}`);
    const pause = new Int32Array(new SharedArrayBuffer(4));
    try {
      mkdirSync(this.store, { recursive: true });
      for (let attempt = 0; attempt < CLOCK_ATTEMPTS; attempt += 1) {
        writeFileSync(probe, "");
        if (lstatSync(probe, { bigint: true }).mtimeNs > time) return;
        Atomics.wait(pause, 0, 0, 1);
      }
    } catch {
      return;
    } finally {
      rmSync(probe, { force: true });
    }
  }

  /**
   * Keeps a copy of each project's module cache for the rest of the run, one per set of installed versions; a set already kept stays as it is. Call it once the journey passed and every app stopped.
   * Returns why each cache that changed after `ajs` installed it was not kept.
   */
  keep(): string[] {
    this.observe();
    const skipped: string[] = [];
    for (const [project, state] of this.projects) {
      const cache = join(project, PROJECT_CACHE);
      const manifest = manifestOf(cache);
      if (manifest === undefined || manifest.modules.length === 0) continue;
      const modules = manifest.modules.filter(([, version]) =>
        REGISTRY_VERSION.test(version),
      );
      const left = manifest.modules
        .filter(([, version]) => !REGISTRY_VERSION.test(version))
        .map(([name]) => name);
      const target = join(
        this.store,
        createHash("sha256")
          .update(modules.map((entry) => entry.join("@")).join("\n"))
          .digest("hex")
          .slice(0, 16),
      );
      if (modules.length > 0 && existsSync(target)) continue;
      const change =
        state.refused ??
        (modules.length === 0
          ? `${manifest.modules[0]?.join("@")} is not a registry version, and ajs updates a git module in place`
          : changeIn(cache, state.installed, manifest.mtime, left));
      if (change !== undefined) {
        skipped.push(`${cache}: ${change}`);
        continue;
      }
      mkdirSync(this.store, { recursive: true });
      publish(
        cache,
        target,
        [cachePath(cache), cache + sep],
        KEPT_CACHE,
        left.length > 0 ? { modules, left } : undefined,
      );
    }
    return skipped;
  }
}
