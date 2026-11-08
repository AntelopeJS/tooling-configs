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

/** A project whose module cache the harness follows: each module as first seen, and the first reason the cache is not exactly what a fresh `ajs` install gives. */
interface Project {
  installed: Map<string, Installed>;
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

/** Every entry under `root`, by its path relative to `root`, with its modification time; symbolic links are listed, not followed. */
function* entries(
  root: string,
  prefix = "",
): Generator<{ path: string; mtime: bigint; directory: boolean }> {
  for (const entry of readdirSync(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = join(prefix, entry.name);
    const directory = entry.isDirectory();
    yield {
      path,
      mtime: lstatSync(join(root, path), { bigint: true }).mtimeNs,
      directory,
    };
    if (directory) yield* entries(root, path);
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
      (current, old) => current.replaceAll(old, to),
      text,
    );
    if (shim !== text) writeFileSync(file, shim);
  }
}

/**
 * Copies `source` into a staging entry next to `target`, replaces each of
 * `from` by `to` in its `.bin` shims, and renames it onto `target`, so a
 * reader sees all of the copy or none of it. A failed copy, a deleted source
 * or a `target` another writer filled first leaves `target` as it was.
 */
function publish(
  source: string,
  target: string,
  from: string[],
  to: string,
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
    });
    retarget(staging, from, to);
    renameSync(staging, target);
  } catch {
    return;
  } finally {
    removeTree(staging);
  }
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
 * modules, which must be no newer than the manifest.
 */
function changeIn(
  cache: string,
  installed: Map<string, Installed>,
  manifest: bigint,
): string | undefined {
  const modules = [...installed].map(([name, module]) => ({
    folder: join(name),
    label: `${name}@${module.version}`,
    bound: module.bound,
  }));
  try {
    for (const { path, mtime, directory } of entries(cache)) {
      if (path === MANIFEST) continue;
      const owner = modules.find(
        ({ folder }) => path === folder || path.startsWith(`${folder}${sep}`),
      );
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
 * lock record the project held before the command, and a git module, which
 * `ajs` updates in place and builds with the project's own install command,
 * each keep the cache out of the store.
 */
export class ProjectCaches {
  private readonly store: string;
  private readonly projects = new Map<string, Project>();

  constructor(store: string) {
    this.store = store;
  }

  /** Gives a project that has installed no module yet a copy of the largest kept cache, so `ajs` reuses the packages an earlier journey installed instead of packing and installing them again. A project whose antelope config names its own `cacheFolder` gets no copy, since `ajs` would not read `.antelope/cache`. */
  seed(project: string): void {
    const state: Project = { installed: new Map() };
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

  /**
   * Records the bound of each module that appeared in a project's manifest
   * since the last call, and refuses the cache of a project whose recorded
   * module left the manifest, changed version or sits in a new folder. A
   * module that appeared with a lock record no newer than `start`, the start
   * of the command that just ended, was installed from that record.
   */
  private observe(start = UNKNOWN_START): void {
    let latest = -1n;
    for (const [project, state] of this.projects) {
      const cache = join(project, PROJECT_CACHE);
      const manifest = manifestOf(cache);
      if (manifest === undefined) continue;
      const listed = new Map(manifest.modules);
      for (const [name, known] of state.installed)
        if (!listed.has(name))
          state.refused ??= `${name} left ${MANIFEST} after ajs installed ${name}@${known.version}`;
      for (const [name, version] of manifest.modules) {
        const born = bornAt(join(cache, name));
        const known = state.installed.get(name);
        if (known === undefined) {
          state.installed.set(name, { version, born, bound: manifest.mtime });
          if (manifest.mtime > latest) latest = manifest.mtime;
          if (pinned(project, name, version, start))
            state.refused ??= `ajs installed ${name}@${version} from the project's lock record`;
        } else if (known.version !== version) {
          state.refused ??= `${name} changed from ${known.version} to ${version} after ajs installed it`;
        } else if (born !== known.born) {
          state.refused ??= `${name} was created again after ajs installed ${name}@${version}`;
        }
      }
    }
    if (latest >= 0n) this.passClock(latest);
  }

  /** Observes the project caches once a command or an app start has ended, and returns its result. Its `folder` is the step folder the harness created as it began, so a lock record no newer than that folder was there before the command. */
  observed<Result extends { folder: string }>(result: Result): Result {
    this.observe(bornAt(result.folder) || UNKNOWN_START);
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
      const target = join(
        this.store,
        createHash("sha256")
          .update(manifest.modules.map((entry) => entry.join("@")).join("\n"))
          .digest("hex")
          .slice(0, 16),
      );
      if (existsSync(target)) continue;
      const unregistered = manifest.modules.find(
        ([, version]) => !REGISTRY_VERSION.test(version),
      );
      const change =
        state.refused ??
        (unregistered === undefined
          ? changeIn(cache, state.installed, manifest.mtime)
          : `${unregistered.join("@")} is not a registry version, and ajs updates a git module in place`);
      if (change !== undefined) {
        skipped.push(`${cache}: ${change}`);
        continue;
      }
      mkdirSync(this.store, { recursive: true });
      publish(cache, target, [cachePath(cache), cache + sep], KEPT_CACHE);
    }
    return skipped;
  }
}
