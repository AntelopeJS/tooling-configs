import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { readCeilings } from "./ceilings.ts";
import { lintDiagnostics, type Diagnostic } from "./oxlint.ts";
import { withPreviousTree } from "./previous-tree.ts";
import { renamedPaths } from "./renames.ts";
import { stagedAdditions } from "./staged-additions.ts";
import { suppressionBase } from "./suppression-base.ts";

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

const LINT_CONFIG =
  /(?:^|\/)(?:oxlint\.config\.[cm]?[jt]s|\.oxlintrc\.jsonc?)$/u;

interface Comparison {
  revision: string | undefined;
  label: string;
  note?: string;
}

function comparisonBase(root: string): Comparison {
  const base = suppressionBase(root);
  const name = process.env.GITHUB_BASE_REF
    ? `origin/${process.env.GITHUB_BASE_REF}`
    : "origin/HEAD";
  if (base === undefined)
    return {
      revision: undefined,
      label: "HEAD",
      note: "No pull request base resolved (GITHUB_BASE_REF or origin/HEAD), so this compared with HEAD. Run `git remote set-head origin --auto` to compare with the merge-base, as CI does.",
    };
  const result = spawnSync("git", ["merge-base", base, "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0)
    return {
      revision: undefined,
      label: "HEAD",
      note: `HEAD has no merge-base with ${name}, so this compared with HEAD. Fetch ${name} with its history to compare with the merge-base, as CI does.`,
    };
  const revision = result.stdout.trim();
  return {
    revision,
    label: `merge-base ${revision.slice(0, 12)} with ${name}`,
  };
}

function baseCounts(
  root: string,
  targets: string[],
  revision: string | undefined,
): Map<string, number> {
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
  return countByRule(
    withPreviousTree(
      root,
      revision ?? "HEAD",
      previous.filter((file) => !LINT_CONFIG.test(file)),
      (tree) => {
        const existing = previous.filter((file) =>
          existsSync(join(tree, file)),
        );
        return existing.length
          ? lintDiagnostics(tree, undefined, existing)
          : [];
      },
    ),
  );
}

/**
 * Fails each ceilinged rule whose findings in the staged files outnumber those
 * the same files, rename sources and deleted files had at the merge-base of
 * HEAD with the pull request base (`GITHUB_BASE_REF`, else `origin/HEAD`), or
 * at HEAD when no base resolves. The count is net across the staged files, so
 * a block moved between them, a legacy line that is reformatted, or a line
 * restored to its base form passes; any net rise fails, and lists the findings
 * on the lines that differ from the base.
 */
export function stagedRatchet(root: string, files?: string[]): string[] {
  const targets = files ?? stagedNames(root, "ACMR");
  if (!targets.length) return [];
  const ceilings = readCeilings(root);
  const after = lintDiagnostics(root, undefined, targets).filter(({ rule }) =>
    Object.hasOwn(ceilings.rules, rule),
  );
  if (!after.length) return [];
  const base = comparisonBase(root);
  const before = baseCounts(root, targets, base.revision);
  const additions = stagedAdditions(root, targets, base.revision);
  const failures: string[] = [];
  for (const [rule, total] of countByRule(after)) {
    const rise = total - (before.get(rule) ?? 0);
    if (rise <= 0) continue;
    const matches = after.filter((diagnostic) => diagnostic.rule === rule);
    const added = matches.filter(
      ({ file, line }) =>
        line !== undefined &&
        additions
          .get(file)
          ?.some(({ start, end }) => line >= start && line <= end),
    );
    failures.push(
      `${rule}: this commit adds ${rise} to the staged files (${before.get(rule) ?? 0} at ${base.label}, ${total} staged); the ceiling covers only legacy findings.`,
      ...(added.length ? added : matches).map(
        (diagnostic) =>
          `  ${diagnostic.location}: ${diagnostic.message}\n    Fix: ${diagnostic.help ?? "Resolve this finding; moving, reformatting or restoring a legacy finding to its base form is allowed, adding one is not."}`,
      ),
    );
  }
  return failures.length && base.note ? [...failures, base.note] : failures;
}
