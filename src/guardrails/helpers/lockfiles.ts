import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** What a run that writes nothing leaves as it was: a lockfile's inode and mtime, and its folder's mtime and listing. */
export function folderStamp(folder: string, lockfile: string) {
  const stats = statSync(join(folder, lockfile));
  return {
    inode: stats.ino,
    lockfile: stats.mtimeMs,
    folder: statSync(folder).mtimeMs,
    entries: readdirSync(folder).sort(),
    nodeModules: existsSync(join(folder, "node_modules")),
  };
}

/** A private package with no dependency. */
export const NO_DEPENDENCIES = {
  name: "fixture",
  version: "1.0.0",
  private: true,
};
