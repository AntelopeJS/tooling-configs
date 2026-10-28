import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { changedFiles } from "./files.ts";
import { renamedPaths } from "./renames.ts";
import { stagedAdditions } from "./staged-ratchet.ts";
import { checkStagedPolicy } from "./suppression-policy.ts";
import {
  countSuppressions,
  revisionSuppressions,
  worktreeSuppressions,
  type Suppression,
  type SuppressionCounts,
} from "./suppressions.ts";

/** The per-repository suppression budget, at the repository root. It is permanent: nothing deletes it, even at zero. */
export const SUPPRESSIONS_FILE = "guardrails.suppressions.json";

/** What a failure tells the author to do. */
const SUPPRESSION_FIX =
  "Fix: fix the code, or remove another suppression of the same kind; a rule that keeps needing suppressions should be changed in the preset.";

const LABELS = {
  tsExpectError: "`@ts-expect-error`",
  tsIgnore: "`@ts-ignore`",
  safety: "`SAFETY:` comments",
};

function labelOf(suppression: Suppression): string {
  return suppression.kind === "rule"
    ? `lint rule \`${suppression.rule}\``
    : LABELS[suppression.kind];
}

/** The rule a SAFETY comment satisfies, so a directive disabling it may become a SAFETY comment without a raise. */
export const SAFETY_RULE =
  "anti-slop/require-safety-comment-for-type-assertion";

/** The safety ceiling plus the room the directives disabling the SAFETY rule leave below theirs, so the two only ever shrink together. */
export function safetyCeiling(
  budget: SuppressionCounts,
  disables: number,
): number {
  return (
    budget.safety + Math.max(0, (budget.rules[SAFETY_RULE] ?? 0) - disables)
  );
}

function limitOf(budget: SuppressionCounts, suppression: Suppression): number {
  return suppression.kind === "rule"
    ? (budget.rules[suppression.rule] ?? 0)
    : budget[suppression.kind];
}

function count(value: number | undefined, source: string): number {
  if (value === undefined) throw new Error(`${source} is missing`);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${source} must be a non-negative integer`);
  return value;
}

/** Parses a budget, rejecting a missing field and anything but non-negative integer ceilings. */
export function parseBudget(text: string, source: string): SuppressionCounts {
  /* SAFETY: JSON text yields plain data; every field is checked below before it is returned. */
  const parsed = JSON.parse(text) as Partial<SuppressionCounts> | null;
  if (parsed === null || Array.isArray(parsed))
    throw new Error(`${source}: expected an object with "rules"`);
  const rules = parsed.rules ?? {};
  if (rules === null || Array.isArray(rules))
    throw new Error(`${source}: rules must be an object of counts`);
  return {
    rules: Object.fromEntries(
      Object.entries(rules).map(([rule, limit]) => [
        rule,
        count(limit, `${source}: rules "${rule}"`),
      ]),
    ),
    tsExpectError: count(parsed.tsExpectError, `${source}: tsExpectError`),
    tsIgnore: count(parsed.tsIgnore, `${source}: tsIgnore`),
    safety: count(parsed.safety, `${source}: safety`),
  };
}

/** Serializes a budget with sorted rules, zero ceilings kept, so rewriting an unchanged budget is a no-op. */
export function formatBudget(budget: SuppressionCounts): string {
  const rules = Object.fromEntries(
    Object.entries(budget.rules).sort(([a], [b]) => a.localeCompare(b)),
  );
  return `${JSON.stringify({ ...budget, rules }, null, 2)}\n`;
}

/** The budget sync writes at adoption: the committed one when the file was only deleted, so recreating it never raises a ceiling, else the current counts. */
export function adoptedBudget(root: string): string {
  const committed = spawnSync("git", ["show", `HEAD:${SUPPRESSIONS_FILE}`], {
    cwd: root,
    encoding: "utf8",
  });
  if (committed.status === 0) return committed.stdout;
  return formatBudget(countSuppressions(worktreeSuppressions(root)));
}

function groupByKey(suppressions: Suppression[]): Map<string, Suppression[]> {
  const groups = new Map<string, Suppression[]>();
  for (const suppression of suppressions) {
    const key = labelOf(suppression);
    groups.set(key, [...(groups.get(key) ?? []), suppression]);
  }
  return groups;
}

function lowered(budget: SuppressionCounts, current: SuppressionCounts) {
  return {
    rules: Object.fromEntries(
      Object.entries(budget.rules).map(([rule, limit]) => [
        rule,
        Math.min(limit, current.rules[rule] ?? 0),
      ]),
    ),
    tsExpectError: Math.min(budget.tsExpectError, current.tsExpectError),
    tsIgnore: Math.min(budget.tsIgnore, current.tsIgnore),
    safety: Math.min(
      safetyCeiling(budget, current.rules[SAFETY_RULE] ?? 0),
      current.safety,
    ),
  };
}

/**
 * Fails each budget key whose count in the working tree is above its ceiling,
 * listing the suppressions in the files this change touches (all of them when
 * it touches none). SAFETY comments may also use the room the
 * directives disabling the SAFETY rule leave below their ceiling. `update`
 * lowers every ceiling to its current count, moving that room to `safety`;
 * no command ever raises the two together.
 */
export function checkSuppressions(root: string, update = false): string[] {
  const path = join(root, SUPPRESSIONS_FILE);
  if (!existsSync(path))
    throw new Error(`${SUPPRESSIONS_FILE} is missing. Run antelopejs-sync.`);
  const budget = parseBudget(readFileSync(path, "utf8"), SUPPRESSIONS_FILE);
  const suppressions = worktreeSuppressions(root);
  const counts = countSuppressions(suppressions);
  const changed = changedFiles(root);
  const failures: string[] = [];
  for (const [key, found] of groupByKey(suppressions)) {
    const limit =
      found[0].kind === "safety"
        ? safetyCeiling(budget, counts.rules[SAFETY_RULE] ?? 0)
        : limitOf(budget, found[0]);
    if (found.length <= limit) continue;
    const inChanged = found.filter(({ file }) => changed.has(file));
    const shown = inChanged.length ? inChanged : found;
    failures.push(
      `${SUPPRESSIONS_FILE}: ${key}: ${found.length} exceeds ceiling ${limit}.`,
      ...shown.map(({ file, line }) => `  ${file}:${line}`),
      ...(shown.length < found.length
        ? [
            `  ...and ${found.length - shown.length} in files this change does not touch.`,
          ]
        : []),
    );
  }
  if (update) writeFileSync(path, formatBudget(lowered(budget, counts)));
  return failures.length ? [...failures, SUPPRESSION_FIX] : [];
}

function budgetAt(root: string, revision: string) {
  const result = spawnSync(
    "git",
    ["show", `${revision}:${SUPPRESSIONS_FILE}`],
    { cwd: root, encoding: "utf8" },
  );
  return result.status === 0
    ? parseBudget(result.stdout, `${revision || "index"}:${SUPPRESSIONS_FILE}`)
    : undefined;
}

function stagedNames(root: string, filter: string): string[] {
  return execFileSync(
    "git",
    [
      "diff",
      "--cached",
      "--name-only",
      "--find-renames",
      `--diff-filter=${filter}`,
      "-z",
    ],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
}

/**
 * Compares the staged files' suppressions with those files at HEAD, rename
 * sources and deleted files included, and fails each key that rises by more
 * than the staged budget raises its ceiling, then applies the suppression
 * policy to what the commit adds. A commit that first adds the budget is
 * not compared.
 */
export function stagedSuppressions(root: string): string[] {
  const renames = renamedPaths(root, true);
  const staged = stagedNames(root, "ACMR");
  const previous = [
    ...staged.map((file) => renames.get(file) ?? file),
    ...stagedNames(root, "D"),
  ];
  return [
    ...stagedBudget(root, staged, previous),
    ...checkStagedPolicy(root, staged, previous),
  ];
}

function stagedBudget(
  root: string,
  staged: string[],
  previous: string[],
): string[] {
  const head = budgetAt(root, "HEAD");
  if (head === undefined) return [];
  const index = budgetAt(root, "") ?? head;
  const before = groupByKey(revisionSuppressions(root, "HEAD", previous));
  const after = groupByKey(revisionSuppressions(root, "", staged));
  const additions = stagedAdditions(root, [
    ...new Set([...after.values()].flat().map(({ file }) => file)),
  ]);
  const failures: string[] = [];
  const safetyRule = `lint rule \`${SAFETY_RULE}\``;
  const converted = Math.max(
    0,
    (before.get(safetyRule)?.length ?? 0) -
      (after.get(safetyRule)?.length ?? 0),
  );
  for (const [key, found] of after) {
    const rise = found.length - (before.get(key)?.length ?? 0);
    const allowance =
      Math.max(0, limitOf(index, found[0]) - limitOf(head, found[0])) +
      (found[0].kind === "safety" ? converted : 0);
    if (rise <= allowance) continue;
    const added = found.filter(({ file, line }) =>
      additions
        .get(file)
        ?.some(({ start, end }) => line >= start && line <= end),
    );
    failures.push(
      `${key}: this commit adds ${rise} to the staged files.`,
      ...(added.length ? added : found).map(
        ({ file, line }) => `  ${file}:${line}`,
      ),
    );
  }
  return failures.length ? [...failures, SUPPRESSION_FIX] : [];
}
