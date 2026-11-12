import { readlinkSync } from "node:fs";
import { join } from "node:path";

/** Whether the symlink at `link` under `root` holds exactly `target`, a relative path with `/`; on Windows, which stores a `/` target with `\` separators, the stored text is read back with `/`. */
export function linkPointsAt(
  root: string,
  link: string,
  target: string,
): boolean {
  const text = readlinkSync(join(root, link));
  return (
    (process.platform === "win32" ? text.replaceAll("\\", "/") : text) ===
    target
  );
}
