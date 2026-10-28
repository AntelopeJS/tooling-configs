import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(root: string, args: string[], env: NodeJS.ProcessEnv, input = "") {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
    input,
    maxBuffer: 256 * 1024 * 1024,
  });
}

function headEntries(root: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const entry of git(root, ["ls-tree", "-r", "-z", "HEAD"], {}).split(
    "\0",
  )) {
    const tab = entry.indexOf("\t");
    if (tab > 0) entries.set(entry.slice(tab + 1), entry.slice(0, tab));
  }
  return entries;
}

/**
 * Runs `use` on a checkout of the index in which each of `paths` holds its
 * HEAD content, or is absent when HEAD does not have it, so the files are
 * linted under the staged configuration. The checkout is deleted afterwards.
 */
export function withPreviousTree<Result>(
  root: string,
  paths: string[],
  use: (tree: string) => Result,
): Result {
  const scratch = mkdtempSync(join(tmpdir(), "antelopejs-previous."));
  try {
    const hasHead =
      spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
        cwd: root,
        stdio: "ignore",
      }).status === 0;
    const index = join(scratch, "index");
    copyFileSync(
      git(
        root,
        ["rev-parse", "--path-format=absolute", "--git-path", "index"],
        {},
      ).trim(),
      index,
    );
    const env = { GIT_INDEX_FILE: index };
    const head = hasHead ? headEntries(root) : new Map<string, string>();
    const restored = paths.filter((path) => head.has(path));
    const removed = paths.filter((path) => !head.has(path));
    if (restored.length)
      git(
        root,
        ["update-index", "-z", "--index-info"],
        env,
        restored.map((path) => `${head.get(path)}\t${path}\0`).join(""),
      );
    if (removed.length)
      git(
        root,
        ["update-index", "-z", "--force-remove", "--stdin"],
        env,
        removed.map((path) => `${path}\0`).join(""),
      );
    const tree = join(scratch, "tree");
    git(root, ["checkout-index", "-a", "-f", `--prefix=${tree}/`], env);
    if (existsSync(join(root, "node_modules")))
      symlinkSync(
        join(root, "node_modules"),
        join(tree, "node_modules"),
        "dir",
      );
    return use(tree);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
