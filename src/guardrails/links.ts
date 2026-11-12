import { readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Whether the symlink at `link` under `root` points at `target`, given relative to the link's folder; compares resolved paths, because Windows stores a `/` target with `\` separators. */
export function linkPointsAt(
  root: string,
  link: string,
  target: string,
): boolean {
  const path = join(root, link);
  return (
    resolve(dirname(path), readlinkSync(path)) ===
    resolve(dirname(path), target)
  );
}
