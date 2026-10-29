import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Verdict, VerdictResult } from "./verdict.ts";
import { git, type RunState } from "./workspace.ts";

const EVIDENCE_BRANCH = "verify-evidence";
const SCRATCH_BRANCH = "verify-evidence-scratch";

const STATUS = {
  PASS: "success",
  "PASS+NOTES": "success",
  "NOT VERIFIED": "error",
  FAIL: "failure",
} satisfies { [Result in VerdictResult]: string };

/** What GitHub holds for the `verify` status after publish wrote it, or the error it answered. */
export interface StatusOutcome {
  ok: boolean;
  detail: string;
}

/**
 * Commits the run's evidence under pr-<n>/<sha>/ of the orphan evidence
 * branch and pushes it. Works in a temporary worktree so the checkout under
 * review is never touched. Returns the pushed evidence commit.
 */
export function pushEvidence(
  root: string,
  state: RunState,
  verdict: Verdict,
): string {
  const worktree = mkdtempSync(join(tmpdir(), "verify-evidence-"));
  try {
    if (git(root, ["ls-remote", "--heads", "origin", EVIDENCE_BRANCH]) !== "") {
      git(root, [
        "fetch",
        "--quiet",
        "origin",
        `${EVIDENCE_BRANCH}:refs/remotes/origin/${EVIDENCE_BRANCH}`,
      ]);
      git(root, [
        "worktree",
        "add",
        "--quiet",
        "--detach",
        worktree,
        `origin/${EVIDENCE_BRANCH}`,
      ]);
    } else
      git(root, [
        "worktree",
        "add",
        "--quiet",
        "--orphan",
        "-B",
        SCRATCH_BRANCH,
        worktree,
      ]);
    const target = join(worktree, `pr-${verdict.pr}`, verdict.headSha);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    cpSync(state.evidence, target, { recursive: true });
    git(worktree, ["add", "--all", "."]);
    git(worktree, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      `verify: evidence for #${verdict.pr} at ${verdict.headSha.slice(0, 7)} (${verdict.result})`,
    ]);
    git(worktree, [
      "push",
      "--quiet",
      "origin",
      `HEAD:refs/heads/${EVIDENCE_BRANCH}`,
    ]);
    return git(worktree, ["rev-parse", "HEAD"]);
  } finally {
    git(root, ["worktree", "remove", "--force", worktree]);
    if (git(root, ["branch", "--list", SCRATCH_BRANCH]) !== "")
      git(root, ["branch", "--quiet", "-D", SCRATCH_BRANCH]);
  }
}

/** Posts the verdict as a PR comment and returns the comment URL printed by gh. */
export function postComment(root: string, verdict: Verdict): string {
  return execFileSync(
    "gh",
    [
      "pr",
      "comment",
      String(verdict.pr),
      "--repo",
      verdict.repository,
      "--body",
      verdict.markdown,
    ],
    { cwd: root, encoding: "utf8" },
  ).trim();
}

/**
 * Sets the `verify` commit status on the head SHA the verdict judged and
 * reads it back from GitHub. Returns what GitHub holds, or the error GitHub
 * answered, so a token without `statuses: write` is reported, never hidden.
 */
export function setStatus(
  root: string,
  verdict: Verdict,
  targetUrl: string,
): StatusOutcome {
  const write = spawnSync(
    "gh",
    [
      "api",
      "--silent",
      `repos/${verdict.repository}/statuses/${verdict.headSha}`,
      "-f",
      `state=${STATUS[verdict.result]}`,
      "-f",
      "context=verify",
      "-f",
      `description=verify: ${verdict.result}`,
      "-f",
      `target_url=${targetUrl}`,
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (write.status !== 0)
    return {
      ok: false,
      detail: `setting status verify failed: ${(write.stderr || write.stdout).trim()}`,
    };
  const read = spawnSync(
    "gh",
    [
      "api",
      `repos/${verdict.repository}/commits/${verdict.headSha}/statuses`,
      "--jq",
      '[.[] | select(.context == "verify")][0].state',
    ],
    { cwd: root, encoding: "utf8" },
  );
  const state = read.stdout.trim();
  return {
    ok: state === STATUS[verdict.result],
    detail: `status verify on ${verdict.headSha}: ${state || "absent"}`,
  };
}
