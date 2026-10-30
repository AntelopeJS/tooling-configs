import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { coveredLimits } from "./config-scopes.ts";
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

function fetchBase(root: string, branch: string, remote: string): void {
  const result = spawnSync(
    "git",
    [
      "fetch",
      "--quiet",
      "--no-tags",
      "--depth=1",
      "origin",
      `+refs/heads/${branch}:${remote}`,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  if (result.status === 0) return;
  const detail = result.error?.message ?? result.stderr.trim();
  throw new Error(
    `Cannot compare with the pull request base: ${remote} is missing and fetching ${branch} from origin failed${detail ? ` (${detail})` : ""}. In CI, fetch the base branch before this check with credentials, or pass --base.`,
  );
}

/**
 * The commit a pull request merges into: `base` when given; in CI the
 * `GITHUB_BASE_REF` branch, taken from the local `origin/<branch>` ref when
 * present and otherwise fetched from `origin`, an error naming the missing ref
 * when the fetch fails; otherwise `origin/HEAD`, the remote's default branch.
 * A requested base that cannot be resolved is an error; without one, a
 * repository with no `origin/HEAD` has no base.
 */
export function suppressionBase(
  root: string,
  base?: string,
): string | undefined {
  if (base !== undefined) return resolveRevision(root, base);
  const branch = process.env.GITHUB_BASE_REF;
  if (branch) {
    const remote = `refs/remotes/origin/${branch}`;
    if (verified(root, remote) === undefined) fetchBase(root, branch, remote);
    return resolveRevision(root, remote);
  }
  return verified(root, "refs/remotes/origin/HEAD");
}

/**
 * Fails each ceiling of the working-tree budget that is higher than on
 * `revision`, and each rule that `revision` lists but the working tree
 * dropped, config rule-offs included once the base has their ceilings; a
 * config ceiling may rise by what a containing scope of its rule falls. The
 * safety ceiling may rise by what the SAFETY rule's own ceiling falls. A
 * base without a budget, a first adoption, passes.
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
  const baseConfig = base.config ?? {};
  const covered = coveredLimits(baseConfig, current.config ?? {});
  for (const rule of new Set([
    ...Object.keys(baseConfig),
    ...Object.keys(current.config ?? {}),
  ]))
    if (base.config !== undefined)
      compare(
        `lint config rule-off \`${rule}\``,
        covered[rule] ?? 0,
        current.config === undefined ||
          (Object.hasOwn(baseConfig, rule) &&
            !Object.hasOwn(current.config, rule))
          ? undefined
          : (current.config[rule] ?? 0),
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
