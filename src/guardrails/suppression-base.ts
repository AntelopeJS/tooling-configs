import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveRevision } from "./files.ts";
import {
  parseBudget,
  SAFETY_RULE,
  safetyCeiling,
  SUPPRESSIONS_FILE,
} from "./suppression-budget.ts";

function verified(root: string, ref: string): string | undefined {
  const result = spawnSync(
    "git",
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
    { cwd: root, encoding: "utf8" },
  );
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/**
 * The commit a pull request merges into: `base` when given; in CI the
 * `GITHUB_BASE_REF` branch, fetched from `origin` when a shallow checkout
 * lacks it; otherwise `origin/HEAD`, the remote's default branch. A requested
 * base that cannot be resolved is an error; without one, a repository with no
 * `origin/HEAD` has no base.
 */
export function suppressionBase(
  root: string,
  base?: string,
): string | undefined {
  if (base !== undefined) return resolveRevision(root, base);
  const branch = process.env.GITHUB_BASE_REF;
  if (branch) {
    const remote = `refs/remotes/origin/${branch}`;
    if (verified(root, remote) === undefined)
      execFileSync(
        "git",
        [
          "fetch",
          "--quiet",
          "--no-tags",
          "--depth=1",
          "origin",
          `+refs/heads/${branch}:${remote}`,
        ],
        { cwd: root, stdio: ["ignore", "ignore", "pipe"] },
      );
    return resolveRevision(root, remote);
  }
  return verified(root, "refs/remotes/origin/HEAD");
}

/**
 * Fails each ceiling of the working-tree budget that is higher than on
 * `revision`, and each rule that `revision` lists but the working tree
 * dropped. The safety ceiling may rise by what the SAFETY rule's own
 * ceiling falls. A base without a budget, a first adoption, passes.
 */
export function raisedCeilings(root: string, revision: string): string[] {
  const committed = spawnSync(
    "git",
    ["show", `${revision}:${SUPPRESSIONS_FILE}`],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  if (committed.status !== 0) return [];
  const label = `${revision.slice(0, 12)}:${SUPPRESSIONS_FILE}`;
  const base = parseBudget(committed.stdout, label);
  const current = parseBudget(
    readFileSync(join(root, SUPPRESSIONS_FILE), "utf8"),
    SUPPRESSIONS_FILE,
  );
  const failures: string[] = [];
  const compare = (key: string, before: number, after: number | undefined) => {
    if (after === undefined)
      failures.push(
        `${SUPPRESSIONS_FILE}: removes ${key}, which has ceiling ${before} on the base. Keep the key; lower it with suppressions:update.`,
      );
    else if (after > before)
      failures.push(
        `${SUPPRESSIONS_FILE}: raises ${key} from ${before} on the base to ${after}.`,
      );
  };
  for (const rule of new Set([
    ...Object.keys(base.rules),
    ...Object.keys(current.rules),
  ]))
    compare(
      `lint rule \`${rule}\``,
      base.rules[rule] ?? 0,
      Object.hasOwn(base.rules, rule)
        ? current.rules[rule]
        : (current.rules[rule] ?? 0),
    );
  compare("`@ts-expect-error`", base.tsExpectError, current.tsExpectError);
  compare("`@ts-ignore`", base.tsIgnore, current.tsIgnore);
  compare(
    "`SAFETY:` comments",
    safetyCeiling(base, current.rules[SAFETY_RULE] ?? 0),
    current.safety,
  );
  return failures.length
    ? [
        ...failures,
        "Ceilings only go down. Fix the code, or remove another suppression of the same kind; raising a ceiling needs the operator's approval through the ruleset bypass.",
      ]
    : [];
}
