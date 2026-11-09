import { existsSync } from "node:fs";
import { join } from "node:path";

import { runCommand } from "./run-command.ts";

/** Config scopes stored inside the repository, which every checkout and agent sharing it commits under. */
const SHARED_SCOPES = new Set(["local", "worktree"]);

/** Whether `root` is a git checkout, a `.git` folder or a linked worktree's `.git` file. */
export function isGitCheckout(root: string): boolean {
  return existsSync(join(root, ".git"));
}

/**
 * Fails when the repository's own git config, its `.git/config` shared by every worktree or a worktree's
 * `config.worktree`, sets `user.name` or `user.email`: whoever commits in any checkout of it then signs as that identity.
 * Global, system and command-line settings pass. Returns what failed, naming each file and value, empty when it passed.
 */
export async function checkGitIdentity(
  root: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runCommand(
    "git",
    [
      "config",
      "--show-scope",
      "--show-origin",
      "--get-regexp",
      String.raw`^user\.(name|email)$`,
    ],
    { cwd: root, signal, shell: false },
  );
  if (result.status === 1) return "";
  if (result.status !== 0) return result.output;
  const shared = result.stdout
    .split("\n")
    .filter((line) => SHARED_SCOPES.has(line.split("\t")[0] ?? ""));
  if (!shared.length) return "";
  return `The repository's git config sets a commit identity, so every checkout and agent sharing it commits as that identity:\n${shared
    .map((line) => `  ${line.split("\t").slice(1).join(" ")}\n`)
    .join(
      "",
    )}Remove it with git config --local --unset-all user.name and git config --local --unset-all user.email (--worktree for a config.worktree), and set an identity with --global or per command with git -c.\n`;
}
