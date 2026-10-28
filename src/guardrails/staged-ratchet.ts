import { execFileSync } from "node:child_process";

import { readCeilings } from "./ceilings.ts";
import { lintDiagnostics } from "./oxlint.ts";
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

export function stagedRatchet(root: string, files?: string[]): string[] {
  const targets =
    files ??
    execFileSync(
      "git",
      ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
      { cwd: root, encoding: "utf8" },
    )
      .split("\0")
      .filter(Boolean);
  if (!targets.length) return [];
  const additions = stagedAdditions(root, targets);
  const ceilings = readCeilings(root);
  return lintDiagnostics(root, undefined, targets)
    .filter(
      ({ rule, file, line }) =>
        Object.hasOwn(ceilings.rules, rule) &&
        line !== undefined &&
        additions
          .get(file)
          ?.some(({ start, end }) => line >= start && line <= end),
    )
    .map(
      (diagnostic) =>
        `${diagnostic.location}: ${diagnostic.message} [${diagnostic.rule}]\n  Fix: ${diagnostic.help ?? "Resolve this finding on the added line; the ceiling covers only legacy findings on untouched lines."}`,
    );
}
