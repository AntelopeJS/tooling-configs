import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, statSync } from "node:fs";
import { join } from "node:path";

function git(root: string, args: string[]): string | undefined {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout : undefined;
}

/** Whether git ignores the filesystem's exec bit in the checkout at `root`, as Git for Windows does by setting `core.fileMode` to false. */
function ignoresFileMode(root: string): boolean {
  return git(root, ["config", "--bool", "core.fileMode"])?.trim() === "false";
}

/** Whether `file` under `root` is executable: its filesystem exec bit, or, where git ignores that bit, the `100755` mode git's index records for it. */
export function isExecutable(root: string, file: string): boolean {
  if ((statSync(join(root, file)).mode & 0o111) !== 0) return true;
  return (
    ignoresFileMode(root) &&
    git(root, ["ls-files", "--stage", "--", file])?.startsWith("100755 ") ===
      true
  );
}

/** Sets `file`'s mode; where the filesystem drops the exec bit, as on Windows, and git ignores it, also stages the file with mode `100755`, the only place such a checkout keeps that bit. */
export function makeExecutable(root: string, file: string, mode: number): void {
  const path = join(root, file);
  chmodSync(path, mode);
  if ((statSync(path).mode & 0o111) === 0 && ignoresFileMode(root))
    execFileSync("git", ["update-index", "--add", "--chmod=+x", "--", file], {
      cwd: root,
    });
}
