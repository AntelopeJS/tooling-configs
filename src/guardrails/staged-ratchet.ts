import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { readCeilings } from "./ceilings.ts";
import { lintDiagnostics, type Diagnostic } from "./oxlint.ts";
import { withPreviousTree } from "./previous-tree.ts";
import { renamedPaths } from "./renames.ts";

/** The line ranges each staged file adds against HEAD, following renames. */
export function stagedAdditions(
  root: string,
  targets: string[],
): Map<string, { start: number; end: number }[]> {
  const renames = renamedPaths(root, true);
  const additions = new Map<string, { start: number; end: number }[]>();
  for (const file of targets) {
    const diff = execFileSync(
      "git",
      [
        "diff",
        "--cached",
        "--no-ext-diff",
        "--no-color",
        "--unified=0",
        "--find-renames",
        "--",
        ...[renames.get(file), file].filter((path) => path !== undefined),
      ],
      { cwd: root, encoding: "utf8" },
    );
    additions.set(
      file,
      Array.from(
        diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm),
        ([, line, count]) => ({
          start: Number(line),
          end: Number(line) + Number(count ?? 1) - 1,
        }),
      ),
    );
  }
  return additions;
}

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

function headCounts(root: string, targets: string[]): Map<string, number> {
  const renames = renamedPaths(root, true);
  const previous = [
    ...new Set([
      ...targets.map((file) => renames.get(file) ?? file),
      ...stagedNames(root, "D"),
    ]),
  ];
  return countByRule(
    withPreviousTree(root, previous, (tree) => {
      const existing = previous.filter((file) => existsSync(join(tree, file)));
      return existing.length ? lintDiagnostics(tree, undefined, existing) : [];
    }),
  );
}

/**
 * Fails each ceilinged rule whose findings in the staged files outnumber those
 * the same files, rename sources and deleted files had at HEAD. The count is
 * net across the staged files, so a block moved between them, or a legacy line
 * that is reformatted, passes; any net rise fails, and lists the findings on
 * the lines the commit adds.
 */
export function stagedRatchet(root: string, files?: string[]): string[] {
  const targets = files ?? stagedNames(root, "ACMR");
  if (!targets.length) return [];
  const ceilings = readCeilings(root);
  const after = lintDiagnostics(root, undefined, targets).filter(({ rule }) =>
    Object.hasOwn(ceilings.rules, rule),
  );
  if (!after.length) return [];
  const before = headCounts(root, targets);
  const additions = stagedAdditions(root, targets);
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
      `${rule}: this commit adds ${rise} to the staged files (${before.get(rule) ?? 0} at HEAD, ${total} staged); the ceiling covers only legacy findings.`,
      ...(added.length ? added : matches).map(
        (diagnostic) =>
          `  ${diagnostic.location}: ${diagnostic.message}\n    Fix: ${diagnostic.help ?? "Resolve this finding; moving or reformatting a legacy finding is allowed, adding one is not."}`,
      ),
    );
  }
  return failures;
}
