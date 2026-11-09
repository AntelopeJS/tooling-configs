import { randomBytes } from "node:crypto";
import {
  cpSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, sep } from "node:path";

import { writeOwn } from "./prepared.ts";
import { removeTree } from "./workspace.ts";

/** The file `ajs` lists a project cache's modules in, each name with its version. */
export const MANIFEST = "manifest.json";

/** Stands in a kept cache for the path of the project cache it was kept from, which pnpm 10 and 11 write into the `NODE_PATH` of each `.bin` shim. */
export const KEPT_CACHE = `${sep}@antelopejs-verify-kept-cache@${sep}`;

/** Whether `path` is `folder` or lies under it. */
export function within(folder: string, path: string): boolean {
  return path === folder || path.startsWith(`${folder}${sep}`);
}

/** Every entry under `root` but those `skip` names and what they hold, by its path relative to `root`, with its modification time; symbolic links are listed, not followed. */
export function* entries(
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

/** The path a module installed into `cache` finds it at, with its symbolic links resolved as the working directory of `pnpm` resolves them, ending with a separator. */
export function cachePath(cache: string): string {
  return join(realpathSync(dirname(cache)), basename(cache)) + sep;
}

/** Replaces each of `from`, in order, by `to` in every `.bin` shim under `folder`, never through a hard link another path shares. */
export function retarget(folder: string, from: string[], to: string): void {
  for (const { path, directory } of entries(folder)) {
    if (directory || basename(dirname(path)) !== ".bin") continue;
    const file = join(folder, path);
    if (!lstatSync(file).isFile()) continue;
    const text = readFileSync(file, "utf8");
    const shim = from.reduce(
      (current, old) => current.replaceAll(old, () => to),
      text,
    );
    if (shim !== text) writeOwn(file, shim);
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
export function publish(
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
