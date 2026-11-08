import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { parseApprovedRaises } from "./approved-raises.ts";
import { CEILINGS_FILE, parseCeilings, readCeilings } from "./ceilings.ts";
import {
  lintDiagnostics,
  type Diagnostic,
  type LintOptions,
} from "./oxlint.ts";
import { withPreviousTree } from "./previous-tree.ts";
import { LINT_CONFIG } from "./files.ts";
import { renamedPaths } from "./renames.ts";
import {
  previousLine,
  stagedAdditions,
  stagedChanges,
  type StagedChanges,
} from "./staged-additions.ts";
import { suppressionBase } from "./suppression-base.ts";

/** The staged hook measures the real tree and a scratch checkout, so a project that fails to load in either must stop it. */
const STAGED_LINT: LintOptions = { rejectBrokenProject: true };

function stagedNames(root: string, filter: string): string[] {
  return execFileSync(
    "git",
    [
      "diff",
      "--cached",
      "--name-only",
      "--ignore-submodules=all",
      `--diff-filter=${filter}`,
      "-z",
    ],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
}

function countByRule(diagnostics: Diagnostic[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { rule } of diagnostics)
    counts.set(rule, (counts.get(rule) ?? 0) + 1);
  return counts;
}

type Comparison =
  | { revision: string; label: string }
  | { revision: undefined; note: string };

function comparisonBase(root: string): Comparison {
  const base = suppressionBase(root);
  const name = process.env.GITHUB_BASE_REF
    ? `origin/${process.env.GITHUB_BASE_REF}`
    : "origin/HEAD";
  if (base === undefined)
    return {
      revision: undefined,
      note: "No pull request base resolved (GITHUB_BASE_REF or origin/HEAD), so this compared with HEAD only. Run `git remote set-head origin --auto` to also compare with the merge-base, as CI does.",
    };
  const result = spawnSync("git", ["merge-base", base, "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0)
    return {
      revision: undefined,
      note: `HEAD has no merge-base with ${name}, so this compared with HEAD only. Run \`git fetch --unshallow origin\` (or \`git fetch origin <default-branch>\` when HEAD is not shallow) to also compare with the merge-base, as CI does.`,
    };
  const revision = result.stdout.trim();
  return {
    revision,
    label: `merge-base ${revision.slice(0, 12)} with ${name}`,
  };
}

function previousDiagnostics(
  root: string,
  targets: string[],
  revision: string | undefined,
): Diagnostic[] {
  const renames = renamedPaths(
    root,
    true,
    revision === undefined ? [] : [revision],
  );
  const deletedFrom =
    revision === undefined
      ? new Map<string, string>()
      : renamedPaths(root, false, [revision, "HEAD"]);
  const previous = [
    ...new Set([
      ...targets.map((file) => renames.get(file) ?? file),
      ...stagedNames(root, "D").map((file) => deletedFrom.get(file) ?? file),
    ]),
  ];
  return withPreviousTree(
    root,
    revision ?? "HEAD",
    previous.filter((file) => !LINT_CONFIG.test(file)),
    (tree) => {
      const existing = previous.filter((file) => existsSync(join(tree, file)));
      return existing.length
        ? lintDiagnostics(tree, undefined, existing, STAGED_LINT)
        : [];
    },
  );
}

/**
 * How many of `staged` sit on a line unchanged since the base and match a
 * finding `previous` reports on that line of the base, each base finding
 * matched once.
 */
function keptFindings(
  staged: Diagnostic[],
  previous: Diagnostic[],
  changes: Map<string, StagedChanges>,
): number {
  const pool = new Map<string, number>();
  for (const { file, line } of previous) {
    const key = `${file}:${line}`;
    pool.set(key, (pool.get(key) ?? 0) + 1);
  }
  let kept = 0;
  for (const { file, line } of staged) {
    const change = changes.get(file);
    if (line === undefined || change === undefined) continue;
    const from = previousLine(change.hunks, line);
    const key = `${change.previous}:${from}`;
    const left = pool.get(key) ?? 0;
    if (from === undefined || left === 0) continue;
    pool.set(key, left - 1);
    kept += 1;
  }
  return kept;
}

/**
 * Per rule, the findings in the files the branch changed since `revision`, at
 * `revision` and in the index, so a merge-base credit is only paid while the
 * branch as a whole does not raise the rule.
 */
function branchCounts(root: string, revision: string) {
  const paths = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "--no-renames", "-z", revision],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter((file) => file && !LINT_CONFIG.test(file));
  const lint = (tree: string) => {
    const existing = paths.filter((file) => existsSync(join(tree, file)));
    return countByRule(
      existing.length
        ? lintDiagnostics(tree, undefined, existing, STAGED_LINT)
        : [],
    );
  };
  return {
    before: withPreviousTree(root, revision, paths, lint),
    after: withPreviousTree(root, revision, [], lint),
  };
}

/** The ceilings `revision` (`:` for the index, which is what the commit will write; `HEAD:`) records; none when it has no ceilings file. */
function ceilingsAt(root: string, revision: string): Record<string, number> {
  const result = spawnSync("git", ["show", `${revision}${CEILINGS_FILE}`], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) return {};
  return parseCeilings(result.stdout, `${revision}${CEILINGS_FILE}`).rules;
}

/** Failures for each ceiling this commit raises that the variable does not list, so an approval for one rule cannot carry another. */
function unlistedRaises(root: string, approved: Map<string, number>): string[] {
  if (!approved.size) return [];
  const head = ceilingsAt(root, "HEAD:");
  return Object.entries(ceilingsAt(root, ":")).flatMap(([rule, count]) =>
    approved.has(rule) || count <= (head[rule] ?? 0)
      ? []
      : [
          `${rule}: this commit raises its ceiling from ${head[rule] ?? 0} to ${count}; APPROVED_RAISES does not list ${rule}.`,
        ],
  );
}

export interface StagedRatchetResult {
  failures: string[];
  /** One loud line per approved raise this commit relies on. */
  accepted: string[];
}

function unlisted(rule: string, approved: Map<string, number>): string[] {
  return approved.size ? [`  APPROVED_RAISES does not list ${rule}.`] : [];
}

/** Tracked files git is told not to look at (`S` skip-worktree, lowercase assume-unchanged), whose working copy can differ from the index unseen. */
function hiddenTracked(root: string): string[] {
  return execFileSync("git", ["ls-files", "-v", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((line) => /^(S|[a-z]) /u.test(line))
    .map((line) => line.slice(2));
}

/** Tracked files whose working copy differs from the index, deleted ones included. */
function unstagedNames(root: string): string[] {
  return execFileSync("git", ["diff", "--name-only", "--no-renames", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

/** Per file and rule, the findings of whichever run reports more of them. */
function higherPerFile(
  first: Diagnostic[],
  second: Diagnostic[],
): Diagnostic[] {
  const key = ({ file, rule }: Diagnostic) => `${file}\0${rule}`;
  const left = Map.groupBy(first, key);
  const right = Map.groupBy(second, key);
  return [...new Set([...left.keys(), ...right.keys()])].flatMap((group) => {
    const a = left.get(group) ?? [];
    const b = right.get(group) ?? [];
    return a.length >= b.length ? a : b;
  });
}

/**
 * The findings in `targets` as the index holds them. Each file the working
 * tree has is linted there, where untracked generated types resolve; a file
 * whose working copy differs, is deleted, or is hidden from git (skip-worktree,
 * assume-unchanged) is also linted in a checkout of the index, and keeps, per
 * rule, the run that reports more.
 */
function stagedDiagnostics(root: string, targets: string[]): Diagnostic[] {
  const unstaged = new Set([...unstagedNames(root), ...hiddenTracked(root)]);
  const present = targets.filter((file) => existsSync(join(root, file)));
  const inTree = present.length
    ? lintDiagnostics(root, undefined, present, STAGED_LINT)
    : [];
  const inIndex = targets.filter((file) => unstaged.has(file));
  if (!inIndex.length) return inTree;
  return higherPerFile(
    inTree,
    withPreviousTree(
      root,
      "HEAD",
      [],
      (tree) => lintDiagnostics(tree, undefined, inIndex, STAGED_LINT),
      { wholeIndex: true },
    ),
  );
}

function approvalRefusal(
  root: string,
  rule: string,
  max: number,
  holds: number,
): string | undefined {
  const unstaged = unstagedNames(root);
  if (unstaged.length)
    return `${rule}: an approved raise is refused while ${unstaged.length} tracked file(s) have unstaged changes (${unstaged[0]}); stage or stash them first.`;
  const hidden = hiddenTracked(root);
  if (hidden.length)
    return `${rule}: an approved raise is refused while ${hidden.length} tracked file(s) are skip-worktree or assume-unchanged (${hidden[0]}); disable the sparse checkout or clear the bit first.`;
  const staged = ceilingsAt(root, ":")[rule];
  const head = ceilingsAt(root, "HEAD:")[rule] ?? 0;
  if (staged !== max)
    return `${rule}: APPROVED_RAISES approves ${max}, but the staged ${CEILINGS_FILE} records ${staged ?? "no ceiling"}; the commit must write exactly ${max}.`;
  if (max <= head)
    return `${rule}: APPROVED_RAISES approves ${max}, but this commit does not raise the ceiling above ${head} at HEAD.`;
  return holds > max
    ? `${rule}: the repository holds ${holds} findings, but APPROVED_RAISES approves at most ${max}.`
    : undefined;
}

/**
 * Settles `rule` against its approved `max`: it passes while this commit
 * raises the ceiling from HEAD's to exactly `max` and the repository holds no
 * more than `max`, so an approval left set accepts nothing in a later commit.
 */
function settleApproved(
  root: string,
  rule: string,
  max: number,
  { holds, rise, shown }: { holds: number; rise: number; shown: Diagnostic[] },
): StagedRatchetResult {
  const refusal = approvalRefusal(root, rule, max, holds);
  if (refusal === undefined)
    return {
      accepted: [
        `${rule} raised to ${max} (this commit adds ${rise}, ${holds} in the repository, ceiling ${max}), approved through APPROVED_RAISES`,
      ],
      failures: [],
    };
  return {
    accepted: [],
    failures: [
      refusal,
      ...shown.map(
        (diagnostic) => `  ${diagnostic.location}: ${diagnostic.message}`,
      ),
    ],
  };
}

function higherCounts(
  first: Map<string, number>,
  second: Map<string, number>,
): Map<string, number> {
  const higher = new Map(first);
  for (const [rule, count] of second)
    higher.set(rule, Math.max(count, higher.get(rule) ?? 0));
  return higher;
}

function inRanges(
  ranges: Map<string, { start: number; end: number }[]>,
  file: string,
  line: number,
): boolean {
  return (
    ranges.get(file)?.some(({ start, end }) => line >= start && line <= end) ??
    false
  );
}

/**
 * Fails each ceilinged rule whose findings in the staged files, as the index
 * holds them, outnumber both
 * what the same files, rename sources and deleted files had at HEAD and the
 * staged findings that sit, on a line unchanged since the merge-base of HEAD
 * with the pull request base (`GITHUB_BASE_REF`, else `origin/HEAD`), where
 * the merge-base has a finding of the same rule, while the files the branch
 * changed hold no more findings of that rule than at the merge-base; without a
 * merge-base, HEAD alone.
 * The count is net across the staged files, so a block moved between them, a
 * legacy line that is reformatted, a line restored to its base form, or an
 * edit of a file a legacy finding moved into earlier on the branch passes; a
 * rise above both fails, and lists the findings on the lines that differ from
 * HEAD and from the base.
 */
export function stagedRatchet(root: string): StagedRatchetResult {
  const approved = parseApprovedRaises();
  const raised = unlistedRaises(root, approved);
  const accepted: string[] = [];
  const targets = stagedNames(root, "ACMR");
  if (!targets.length) return { failures: raised, accepted };
  const ceilings = readCeilings(root);
  const after = stagedDiagnostics(root, targets).filter(
    ({ rule }) => Object.hasOwn(ceilings.rules, rule) || approved.has(rule),
  );
  if (!after.length) return { failures: raised, accepted };
  const base = comparisonBase(root);
  const atHead = countByRule(previousDiagnostics(root, targets, undefined));
  const headAdditions = stagedAdditions(root, targets);
  const atBase =
    base.revision === undefined
      ? undefined
      : previousDiagnostics(root, targets, base.revision);
  const baseChanges =
    base.revision === undefined
      ? undefined
      : stagedChanges(root, targets, base.revision);
  let branch: ReturnType<typeof branchCounts> | undefined;
  const measure = (
    rule: string,
    matches: Diagnostic[],
    head: number,
    total: number,
  ) => {
    const kept =
      atBase === undefined || baseChanges === undefined
        ? undefined
        : keptFindings(
            matches,
            atBase.filter((diagnostic) => diagnostic.rule === rule),
            baseChanges,
          );
    const rise = total - Math.max(head, kept ?? 0);
    if (kept === undefined || kept <= head || base.revision === undefined)
      return { kept, rise, raised: undefined };
    branch ??= branchCounts(root, base.revision);
    const from = branch.before.get(rule) ?? 0;
    const to = branch.after.get(rule) ?? 0;
    if (to <= from) return { kept, rise, raised: undefined };
    return {
      kept,
      rise: Math.min(total - head, Math.max(to - from, rise)),
      raised: `the files this branch changed hold ${to} at the index against ${from} at that merge-base, so the merge-base credit covers no added finding`,
    };
  };
  const failures: string[] = [];
  let repository: Map<string, number> | undefined;
  for (const [rule, total] of countByRule(after)) {
    const head = atHead.get(rule) ?? 0;
    if (total <= head) continue;
    const matches = after.filter((diagnostic) => diagnostic.rule === rule);
    const { kept, rise, raised } = measure(rule, matches, head, total);
    if (rise <= 0) continue;
    const added = matches.filter(
      ({ file, line }) =>
        line !== undefined &&
        inRanges(headAdditions, file, line) &&
        (baseChanges === undefined ||
          previousLine(baseChanges.get(file)?.hunks ?? [], line) === undefined),
    );
    const max = approved.get(rule);
    if (max !== undefined) {
      repository ??= higherCounts(
        withPreviousTree(
          root,
          "HEAD",
          [],
          (tree) =>
            countByRule(
              lintDiagnostics(tree, undefined, undefined, STAGED_LINT),
            ),
          { wholeIndex: true },
        ),
        countByRule(lintDiagnostics(root, undefined, undefined, STAGED_LINT)),
      );
      const settled = settleApproved(root, rule, max, {
        holds: repository.get(rule) ?? 0,
        rise,
        shown: added.length ? added : matches,
      });
      accepted.push(...settled.accepted);
      failures.push(...settled.failures);
      continue;
    }
    const counts =
      kept === undefined || base.revision === undefined
        ? `${head} at HEAD`
        : `${head} at HEAD, ${kept} unchanged since ${base.label}`;
    failures.push(
      `${rule}: this commit adds ${rise} to the staged files (${counts}, ${total} staged)${raised === undefined ? "" : `; ${raised}`}; the ceiling covers only legacy findings.`,
      ...unlisted(rule, approved),
      ...(added.length ? added : matches).map(
        (diagnostic) =>
          `  ${diagnostic.location}: ${diagnostic.message}\n    Fix: ${diagnostic.help ?? "Resolve this finding; moving, reformatting or restoring a legacy finding to its base form is allowed, adding one is not."}`,
      ),
    );
  }
  failures.unshift(...raised);
  return {
    failures:
      failures.length && base.revision === undefined
        ? [...failures, base.note]
        : failures,
    accepted,
  };
}
