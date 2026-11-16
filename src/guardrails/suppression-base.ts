import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { coveredLimits } from "./config-scopes.ts";
import { isAgentFile, resolveRevision } from "./files.ts";
import { countSuppressions, revisionSuppressions } from "./suppressions.ts";
import type { SuppressionCounts } from "./suppressions.ts";
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

function fieldsDropped(
  base: SuppressionCounts,
  current: SuppressionCounts,
): string[] {
  return [
    ...(base.agentFiles && !current.agentFiles
      ? [
          `${SUPPRESSIONS_FILE}: drops agentFiles, which the base has. Keep it; the repository's own files under the agent directories stay counted.`,
        ]
      : []),
    ...(base.config !== undefined && current.config === undefined
      ? [
          `${SUPPRESSIONS_FILE}: drops config, which the base has. Keep it; without it lint config rule-offs go uncapped.`,
        ]
      : []),
  ];
}

/** How much each key's ceiling may rise by on adopting the agent directories' files. */
interface AdoptableRoom {
  rules: Record<string, number>;
  config: Record<string, number>;
  tsExpectError: number;
  tsIgnore: number;
  safety: number;
}

/** What the agent directories hold, when `current` begins recording them and `base` does not; nothing otherwise. */
function adoptableAgentCounts(
  root: string,
  revision: string,
  base: SuppressionCounts,
  current: SuppressionCounts,
): AdoptableRoom {
  const none = {
    rules: {},
    config: {},
    tsExpectError: 0,
    tsIgnore: 0,
    safety: 0,
  };
  if (base.agentFiles || !current.agentFiles) return none;
  const counts = countSuppressions(
    revisionSuppressions(root, revision).filter(({ file }) =>
      isAgentFile(file),
    ),
  );
  return { ...counts, config: counts.config ?? {} };
}

/**
 * Fails each ceiling of the working-tree budget that is higher than on
 * `revision`, config rule-offs included once the base has their ceilings,
 * and a working tree that drops the `config` the base has; a key the working
 * tree drops is a ceiling of zero, so the ceiling check fails it while it
 * still suppresses something. A config ceiling may rise by what a containing
 * scope of its rule falls. The
 * safety ceiling may rise by what the SAFETY rule's own ceiling falls. A
 * base that does not record the agent directories' files lets the working
 * tree record them, each ceiling rising by no more than its count there; a
 * base that does must keep recording them. A base without a budget, a first
 * adoption, passes.
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
  const failures: string[] = fieldsDropped(base, current);
  const room = adoptableAgentCounts(root, revision, base, current);
  const compare = (
    key: string,
    ceiling: number,
    after: number,
    adoptable = 0,
  ) => {
    const before = ceiling + adoptable;
    if (after > before)
      failures.push(
        `${SUPPRESSIONS_FILE}: raises ${key} from ${ceiling} on the base to ${after}${adoptable ? `, above the ${before} that recording the agent files allows` : ""}.`,
      );
  };
  for (const rule of Object.keys(current.rules))
    compare(
      `lint rule \`${rule}\``,
      base.rules[rule] ?? 0,
      current.rules[rule],
      room.rules[rule],
    );
  if (base.config !== undefined && current.config !== undefined) {
    const covered = coveredLimits(base.config, current.config);
    for (const rule of Object.keys(current.config))
      compare(
        `lint config rule-off \`${rule}\``,
        covered[rule] ?? 0,
        current.config[rule],
        room.config[rule],
      );
  }
  compare(
    "`@ts-expect-error`",
    base.tsExpectError,
    current.tsExpectError,
    room.tsExpectError,
  );
  compare("`@ts-ignore`", base.tsIgnore, current.tsIgnore, room.tsIgnore);
  compare(
    "`SAFETY:` comments",
    safetyCeiling(base, current.rules[SAFETY_RULE] ?? 0),
    current.safety,
    room.safety,
  );
  return failures.length
    ? [
        ...failures,
        "Ceilings only go down. Fix the code, or remove another suppression of the same kind; raising a ceiling needs the operator's approval through the ruleset bypass.",
      ]
    : [];
}
