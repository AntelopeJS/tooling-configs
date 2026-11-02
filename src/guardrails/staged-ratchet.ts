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
    ["diff", "--cached", "--name-only", `--diff-filter=${filter}`, "-z"],
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

/** The ceiling `revision` (`:` for the index, which is what the commit will write; `HEAD:`) records for `rule`. */
function ceilingAt(
  root: string,
  revision: string,
  rule: string,
): number | undefined {
  const result = spawnSync("git", ["show", `${revision}${CEILINGS_FILE}`], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) return undefined;
  return parseCeilings(result.stdout, `${revision}${CEILINGS_FILE}`).rules[
    rule
  ];
}

export interface StagedRatchetResult {
  failures: string[];
  /** One loud line per approved raise this commit relies on. */
  accepted: string[];
}

function unlisted(rule: string, approved: Map<string, number>): string[] {
  return approved.size ? [`  APPROVED_RAISES does not list ${rule}.`] : [];
}

function approvalRefusal(
  root: string,
  rule: string,
  max: number,
  holds: number,
): string | undefined {
  const unstaged = execFileSync("git", ["diff", "--name-only", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  if (unstaged.length)
    return `${rule}: APPROVED_RAISES counts the repository from the working tree, which differs from the index in ${unstaged.length} tracked file(s) with unstaged changes (${unstaged[0]}); stage or stash them first.`;
  const staged = ceilingAt(root, ":", rule);
  const head = ceilingAt(root, "HEAD:", rule) ?? 0;
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
 * Fails each ceilinged rule whose findings in the staged files outnumber both
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
export function stagedRatchet(
  root: string,
  files?: string[],
): StagedRatchetResult {
  const approved = parseApprovedRaises();
  const accepted: string[] = [];
  const targets = files ?? stagedNames(root, "ACMR");
  if (!targets.length) return { failures: [], accepted };
  const ceilings = readCeilings(root);
  const after = lintDiagnostics(root, undefined, targets, STAGED_LINT).filter(
    ({ rule }) => Object.hasOwn(ceilings.rules, rule) || approved.has(rule),
  );
  if (!after.length) return { failures: [], accepted };
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
      repository ??= countByRule(
        lintDiagnostics(root, undefined, undefined, STAGED_LINT),
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
  return {
    failures:
      failures.length && base.revision === undefined
        ? [...failures, base.note]
        : failures,
    accepted,
  };
}
