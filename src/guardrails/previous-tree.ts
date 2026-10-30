import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function git(root: string, args: string[], env: NodeJS.ProcessEnv, input = "") {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
    input,
    maxBuffer: 256 * 1024 * 1024,
  });
}

function revisionEntries(root: string, revision: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const entry of git(root, ["ls-tree", "-r", "-z", revision], {}).split(
    "\0",
  )) {
    const tab = entry.indexOf("\t");
    if (tab > 0) entries.set(entry.slice(tab + 1), entry.slice(0, tab));
  }
  return entries;
}

/** Links the `node_modules` of the repository root and of each tracked package into `tree`, so the checkout resolves dependencies as the real one does. */
function linkModules(root: string, tree: string, env: NodeJS.ProcessEnv): void {
  const manifests = git(
    root,
    ["ls-files", "-z", "--", "package.json", ":(glob)**/package.json"],
    env,
  )
    .split("\0")
    .filter(Boolean);
  for (const manifest of manifests) {
    const directory = dirname(manifest);
    const modules = join(root, directory, "node_modules");
    const target = join(tree, directory, "node_modules");
    if (existsSync(modules) && !existsSync(target))
      symlinkSync(modules, target, "dir");
  }
}

/**
 * Runs `use` on a checkout of the index in which each of `paths` holds its
 * content at `revision`, or is absent when `revision` does not have it or does
 * not exist, so the files are linted under the staged configuration. The
 * checkout is deleted afterwards.
 */
export function withPreviousTree<Result>(
  root: string,
  revision: string,
  paths: string[],
  use: (tree: string) => Result,
): Result {
  const scratch = mkdtempSync(join(tmpdir(), "antelopejs-previous."));
  try {
    const exists =
      spawnSync("git", ["rev-parse", "--verify", `${revision}^{commit}`], {
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
    const head = exists
      ? revisionEntries(root, revision)
      : new Map<string, string>();
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
    linkModules(root, tree, env);
    return use(tree);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
