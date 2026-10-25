import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function trackedManifests(root: string): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(
      (file) => file === "package.json" || file.endsWith("/package.json"),
    );
}

function linkDependencies(root: string, worktree: string): void {
  const directories = new Set([".", ...trackedManifests(root).map(dirname)]);
  for (const directory of directories) {
    const source = join(root, directory, "node_modules");
    const target = join(worktree, directory, "node_modules");
    if (
      existsSync(source) &&
      existsSync(dirname(target)) &&
      !existsSync(target)
    )
      symlinkSync(source, target, "dir");
  }
}

interface RevisionOutput {
  packages: string[];
  entries: number;
}

/** Compares isolated committed revisions and removes both worktrees even when compilation fails. */
export function compareRevisions(
  root: string,
  baseRef: string,
  label: string,
  emit: (worktree: string, output: string, scratch: string) => RevisionOutput,
) {
  const temporary = mkdtempSync(join(tmpdir(), "antelope-proof-"));
  const worktrees: string[] = [];
  const results: RevisionOutput[] = [];
  try {
    for (const [side, ref] of [
      ["base", baseRef],
      ["head", "HEAD"],
    ]) {
      const revision = execFileSync(
        "git",
        ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
      const worktree = join(temporary, "worktrees", side);
      execFileSync(
        "git",
        ["worktree", "add", "--quiet", "--detach", worktree, revision],
        {
          cwd: root,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      worktrees.push(worktree);
      linkDependencies(root, worktree);
      const output = join(temporary, side);
      mkdirSync(output, { recursive: true });
      results.push(emit(worktree, output, join(temporary, "emit", side)));
    }
    const diff = spawnSync(
      "git",
      [
        "diff",
        "--no-index",
        "--no-color",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--",
        "base",
        "head",
      ],
      {
        cwd: temporary,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    if (diff.error) throw diff.error;
    if (diff.status !== 0 && diff.status !== 1)
      throw new Error(diff.stderr || "Could not compare revision outputs.");
    const packages = new Set(results.flatMap((result) => result.packages)).size;
    return {
      different: diff.status === 1,
      output:
        diff.status === 1
          ? `${label}: differences against ${baseRef} (committed HEAD).\n${diff.stdout}`
          : `${label}: ${packages} packages, ${results[1].entries} entries unchanged against ${baseRef} (committed HEAD).\n`,
    };
  } finally {
    for (const worktree of worktrees.reverse())
      execFileSync("git", ["worktree", "remove", "--force", worktree], {
        cwd: root,
        stdio: "pipe",
      });
    rmSync(temporary, { recursive: true, force: true });
  }
}
