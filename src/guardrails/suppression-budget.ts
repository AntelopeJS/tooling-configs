import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { coveredLimits } from "./config-scopes.ts";
import { changedFiles } from "./files.ts";
import { renamedPaths } from "./renames.ts";
import { stagedAdditions } from "./staged-additions.ts";
import { checkStagedPolicy } from "./suppression-policy.ts";
import {
  configKey,
  countSuppressions,
  revisionSuppressions,
  sortedKeys,
  worktreeSuppressions,
  type Suppression,
  type SuppressionCounts,
} from "./suppressions.ts";

/** The per-repository suppression budget, at the repository root. It is permanent: nothing deletes it, even at zero. */
export const SUPPRESSIONS_FILE = "guardrails.suppressions.json";

/** What a failure tells the author to do. */
const SUPPRESSION_FIX =
  "Fix: fix the code, or remove another suppression of the same kind; a rule that keeps needing suppressions should be changed in the preset.";

/** What a failure caused by a lint config rule-off tells the author to do. */
const CONFIG_FIX =
  "Fix: delete the config entry and fix the code its rule reports, or move the exception onto the line that needs it as a directive with a reason. A rule wrong for every repository should be changed in the preset.";

function fixesFor(failed: Suppression[]): string[] {
  return [
    ...(failed.some(({ kind }) => kind !== "config") ? [SUPPRESSION_FIX] : []),
    ...(failed.some(({ kind }) => kind === "config") ? [CONFIG_FIX] : []),
  ];
}

const LABELS = {
  tsExpectError: "`@ts-expect-error`",
  tsIgnore: "`@ts-ignore`",
  safety: "`SAFETY:` comments",
};

function labelOf(suppression: Suppression): string {
  if (suppression.kind === "rule") return `lint rule \`${suppression.rule}\``;
  if (suppression.kind === "config")
    return `lint config rule-off \`${suppression.rule}\` for \`${suppression.scope}\``;
  return LABELS[suppression.kind];
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
  if (suppression.kind === "rule") return budget.rules[suppression.rule] ?? 0;
  if (suppression.kind === "config")
    return budget.config?.[configKey(suppression.rule, suppression.scope)] ?? 0;
  return budget[suppression.kind];
}

/** Whether `budget` caps this kind: config rule-offs go uncapped until sync adopts their ceilings. */
function capped(budget: SuppressionCounts, suppression: Suppression): boolean {
  return suppression.kind !== "config" || budget.config !== undefined;
}

function counted(
  map: Partial<Record<string, number>> | null,
  source: string,
): Record<string, number> {
  if (map === null || Array.isArray(map))
    throw new Error(`${source} must be an object of counts`);
  return Object.fromEntries(
    Object.entries(map).map(([rule, limit]) => [
      rule,
      count(limit, `${source} "${rule}"`),
    ]),
  );
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
  const budget: SuppressionCounts = {
    rules: counted(parsed.rules ?? {}, `${source}: rules`),
    tsExpectError: count(parsed.tsExpectError, `${source}: tsExpectError`),
    tsIgnore: count(parsed.tsIgnore, `${source}: tsIgnore`),
    safety: count(parsed.safety, `${source}: safety`),
  };
  if (parsed.config !== undefined)
    budget.config = counted(parsed.config, `${source}: config`);
  return budget;
}

/** Serializes a budget with sorted rules and config rule-offs, zero ceilings kept, so rewriting an unchanged budget is a no-op. */
export function formatBudget(budget: SuppressionCounts): string {
  const sorted: SuppressionCounts = {
    ...budget,
    rules: sortedKeys(budget.rules),
  };
  if (budget.config !== undefined) sorted.config = sortedKeys(budget.config);
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/** A budget with config rule-off ceilings: `text` itself when it has them or does not parse, else `text` plus today's config rule-offs. */
function withConfigCeilings(root: string, text: string): string {
  let budget: SuppressionCounts;
  try {
    budget = parseBudget(text, SUPPRESSIONS_FILE);
  } catch {
    return text;
  }
  if (budget.config !== undefined) return text;
  const { config } = countSuppressions(worktreeSuppressions(root));
  return formatBudget({ ...budget, config });
}

/**
 * The budget sync writes: `current` with today's config rule-offs adopted
 * when it predates them; when the file is missing, the committed one when it
 * was only deleted, so recreating it never raises a ceiling, else the
 * current counts.
 */
export function adoptedBudget(root: string, current?: string): string {
  if (current !== undefined) return withConfigCeilings(root, current);
  const committed = spawnSync("git", ["show", `HEAD:${SUPPRESSIONS_FILE}`], {
    cwd: root,
    encoding: "utf8",
  });
  if (committed.status === 0) return withConfigCeilings(root, committed.stdout);
  return formatBudget(countSuppressions(worktreeSuppressions(root)));
}

/** Each `file:line` once, indented, in the order found. */
function locations(found: Suppression[]): string[] {
  return [...new Set(found.map(({ file, line }) => `  ${file}:${line}`))];
}

function groupByKey(suppressions: Suppression[]): Map<string, Suppression[]> {
  const groups = new Map<string, Suppression[]>();
  for (const suppression of suppressions) {
    const key = labelOf(suppression);
    groups.set(key, [...(groups.get(key) ?? []), suppression]);
  }
  return groups;
}

/** Each ceiling of `limits` lowered to its count in `current`, rules at zero kept. */
function lowerEach(
  limits: Record<string, number>,
  current: Record<string, number> = {},
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(limits).map(([rule, limit]) => [
      rule,
      Math.min(limit, Object.hasOwn(current, rule) ? current[rule] : 0),
    ]),
  );
}

function lowered(
  budget: SuppressionCounts,
  current: SuppressionCounts,
): SuppressionCounts {
  const result: SuppressionCounts = {
    rules: lowerEach(budget.rules, current.rules),
    tsExpectError: Math.min(budget.tsExpectError, current.tsExpectError),
    tsIgnore: Math.min(budget.tsIgnore, current.tsIgnore),
    safety: Math.min(
      safetyCeiling(budget, current.rules[SAFETY_RULE] ?? 0),
      current.safety,
    ),
  };
  if (budget.config !== undefined)
    result.config = lowerEach(budget.config, current.config);
  return result;
}

/**
 * Fails each budget key whose count in the working tree is above its ceiling,
 * listing the suppressions in the files this change touches (all of them when
 * it touches none). SAFETY comments may also use the room the
 * directives disabling the SAFETY rule leave below their ceiling. `update`
 * lowers every ceiling to its current count, moving that room to `safety`;
 * no command ever raises the two together. A config rule-off may use the
 * room a containing scope of its rule gives up, and `update` moves that room
 * to the narrower key.
 */
export function checkSuppressions(root: string, update = false): string[] {
  const path = join(root, SUPPRESSIONS_FILE);
  if (!existsSync(path))
    throw new Error(`${SUPPRESSIONS_FILE} is missing. Run antelopejs-sync.`);
  const committed = parseBudget(readFileSync(path, "utf8"), SUPPRESSIONS_FILE);
  const suppressions = worktreeSuppressions(root);
  const counts = countSuppressions(suppressions);
  const budget = withCoveredScopes(committed, counts);
  const changed = changedFiles(root);
  const failures: string[] = [];
  const failed: Suppression[] = [];
  for (const [key, found] of groupByKey(suppressions)) {
    if (!capped(budget, found[0])) continue;
    const limit =
      found[0].kind === "safety"
        ? safetyCeiling(budget, counts.rules[SAFETY_RULE] ?? 0)
        : limitOf(budget, found[0]);
    if (found.length <= limit) continue;
    failed.push(found[0]);
    const inChanged = found.filter(({ file }) => changed.has(file));
    const shown = inChanged.length ? inChanged : found;
    failures.push(
      `${SUPPRESSIONS_FILE}: ${key}: ${found.length} exceeds ceiling ${limit}.`,
      ...locations(shown),
      ...(shown.length < found.length
        ? [
            `  ...and ${found.length - shown.length} in files this change does not touch.`,
          ]
        : []),
    );
  }
  if (update) writeFileSync(path, formatBudget(lowered(budget, counts)));
  return [...failures, ...fixesFor(failed)];
}

/** `budget` with each config ceiling widened by the room containing scopes of its rule give up at `counts`. */
function withCoveredScopes(
  budget: SuppressionCounts,
  counts: SuppressionCounts,
): SuppressionCounts {
  if (budget.config === undefined) return budget;
  return {
    ...budget,
    config: coveredLimits(budget.config, counts.config ?? {}),
  };
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

/**
 * How much a staged config key may rise: what the staged budget raises its
 * ceiling, plus what a containing scope of its rule falls in the staged files.
 */
function stagedScopes(
  head: SuppressionCounts,
  index: SuppressionCounts,
  before: Record<string, number>,
  after: Record<string, number>,
): (rule: string, scope: string, previous: number) => number {
  const limits = { ...before };
  for (const key of new Set([
    ...Object.keys(index.config ?? {}),
    ...Object.keys(head.config ?? {}),
  ]))
    limits[key] =
      (limits[key] ?? 0) +
      Math.max(0, (index.config?.[key] ?? 0) - (head.config?.[key] ?? 0));
  const covered = coveredLimits(limits, after);
  return (rule, scope, previous) =>
    (covered[configKey(rule, scope)] ?? 0) - previous;
}

function stagedBudget(
  root: string,
  staged: string[],
  previous: string[],
): string[] {
  const head = budgetAt(root, "HEAD");
  if (head === undefined) return [];
  const index = budgetAt(root, "") ?? head;
  const headSuppressions = revisionSuppressions(root, "HEAD", previous);
  const stagedSuppressions = revisionSuppressions(root, "", staged);
  const before = groupByKey(headSuppressions);
  const after = groupByKey(stagedSuppressions);
  const scopes = stagedScopes(
    head,
    index,
    countSuppressions(headSuppressions).config ?? {},
    countSuppressions(stagedSuppressions).config ?? {},
  );
  const additions = stagedAdditions(root, [
    ...new Set([...after.values()].flat().map(({ file }) => file)),
  ]);
  const failures: string[] = [];
  const failed: Suppression[] = [];
  const safetyRule = `lint rule \`${SAFETY_RULE}\``;
  const converted = Math.max(
    0,
    (before.get(safetyRule)?.length ?? 0) -
      (after.get(safetyRule)?.length ?? 0),
  );
  const freed =
    (head.rules[SAFETY_RULE] ?? 0) - (index.rules[SAFETY_RULE] ?? 0);
  for (const [key, found] of after) {
    if (!capped(index, found[0])) continue;
    const rise = found.length - (before.get(key)?.length ?? 0);
    const raised = limitOf(index, found[0]) - limitOf(head, found[0]);
    const allowance =
      found[0].kind === "safety"
        ? converted + Math.max(0, raised - Math.max(0, freed))
        : found[0].kind === "config"
          ? scopes(found[0].rule, found[0].scope, found.length - rise)
          : Math.max(0, raised);
    if (rise <= allowance) continue;
    failed.push(found[0]);
    const added = found.filter(({ file, line }) =>
      additions
        .get(file)
        ?.some(({ start, end }) => line >= start && line <= end),
    );
    failures.push(
      `${key}: this commit adds ${rise} to the staged files.`,
      ...locations(added.length ? added : found),
    );
  }
  return [...failures, ...fixesFor(failed)];
}
