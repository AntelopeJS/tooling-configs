import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resolveRevision, trackedManifests } from "./files.ts";
import {
  countSuppressions,
  revisionSuppressions,
  type SuppressionCounts,
} from "./suppressions.ts";
import {
  applyAllowance,
  type AddedPolicy,
  type PublishedEntry,
} from "./added-entries.ts";

export const DIRECTORY_LINK = process.platform === "win32" ? "junction" : "dir";

function linkDependencies(root: string, worktree: string): void {
  const directories = new Set([".", ...trackedManifests(root).map(dirname)]);
  for (const directory of directories) {
    const source = join(root, directory, "node_modules");
    const target = join(worktree, directory, "node_modules");
    if (
      existsSync(source) &&
      existsSync(dirname(target)) &&
      !existsSync(target)
    )
      symlinkSync(source, target, DIRECTORY_LINK);
  }
}

interface RevisionOutput {
  packages: string[];
  entries: number;
  published?: PublishedEntry[];
}

/** Compares isolated committed revisions and removes both worktrees even when compilation fails; a policy lets matching `@internal` additions through. */
export function compareRevisions(
  root: string,
  baseRef: string,
  label: string,
  emit: (worktree: string, output: string, scratch: string) => RevisionOutput,
  policy?: AddedPolicy,
) {
  const temporary = mkdtempSync(join(tmpdir(), "antelope-proof-"));
  const worktrees: string[] = [];
  const results: RevisionOutput[] = [];
  try {
    for (const [side, ref] of [
      ["base", baseRef],
      ["head", "HEAD"],
    ]) {
      const revision = execFileSync(
        "git",
        ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
      const worktree = join(temporary, "worktrees", side);
      execFileSync(
        "git",
        ["worktree", "add", "--quiet", "--detach", worktree, revision],
        {
          cwd: root,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      worktrees.push(worktree);
      linkDependencies(root, worktree);
      const output = join(temporary, side);
      mkdirSync(output, { recursive: true });
      results.push(emit(worktree, output, join(temporary, "emit", side)));
    }
    const allowedAdditions =
      policy === undefined
        ? 0
        : applyAllowance(
            policy,
            results[0].published ?? [],
            results[1].published ?? [],
            (path) => rmSync(join(temporary, "head", path), { force: true }),
          );
    const diff = spawnSync(
      "git",
      [
        "diff",
        "--no-index",
        "--no-color",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--",
        "base",
        "head",
      ],
      {
        cwd: temporary,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    if (diff.error) throw diff.error;
    if (diff.status !== 0 && diff.status !== 1)
      throw new Error(diff.stderr || "Could not compare revision outputs.");
    const packages = new Set(results.flatMap((result) => result.packages)).size;
    return {
      different: diff.status === 1,
      output:
        diff.status === 1
          ? `${label}: differences against ${baseRef} (committed HEAD).\n${diff.stdout}`
          : `${label}: ${packages} packages, ${results[1].entries - allowedAdditions} entries unchanged against ${baseRef} (committed HEAD).\n`,
    };
  } finally {
    for (const worktree of worktrees.reverse())
      execFileSync("git", ["worktree", "remove", "--force", worktree], {
        cwd: root,
        stdio: "pipe",
      });
    rmSync(temporary, { recursive: true, force: true });
  }
}

function countRows(base: SuppressionCounts, head: SuppressionCounts) {
  const total = (counts: SuppressionCounts) =>
    Object.values(counts.rules).reduce((sum, count) => sum + count, 0);
  const rules = [
    ...new Set([...Object.keys(base.rules), ...Object.keys(head.rules)]),
  ].sort((a, b) => a.localeCompare(b));
  const configTotal = (counts: SuppressionCounts) =>
    Object.values(counts.config ?? {}).reduce((sum, count) => sum + count, 0);
  const configRules = [
    ...new Set([
      ...Object.keys(base.config ?? {}),
      ...Object.keys(head.config ?? {}),
    ]),
  ].sort((a, b) => a.localeCompare(b));
  return [
    ["Lint suppressions, all rules", total(base), total(head)],
    ...rules.map((rule) => [
      `Lint suppressions, \`${rule}\``,
      base.rules[rule] ?? 0,
      head.rules[rule] ?? 0,
    ]),
    ["`@ts-expect-error`", base.tsExpectError, head.tsExpectError],
    ["`@ts-ignore`", base.tsIgnore, head.tsIgnore],
    ["`SAFETY:` comments", base.safety, head.safety],
    ["Lint config rule-offs, all rules", configTotal(base), configTotal(head)],
    ...configRules.map((rule) => [
      `Lint config rule-offs, \`${rule}\``,
      base.config?.[rule] ?? 0,
      head.config?.[rule] ?? 0,
    ]),
  ];
}

/** The suppression table rows, `| label | base | head |`, counted in authored code files at both revisions with the shared suppression counter. */
export function revisionCountRows(
  root: string,
  baseRef: string,
  headRef = "HEAD",
): string[] {
  const [base, head] = [baseRef, headRef].map((ref) =>
    countSuppressions(revisionSuppressions(root, resolveRevision(root, ref))),
  );
  return countRows(base, head).map(
    ([label, before, after]) => `| ${label} | ${before} | ${after} |`,
  );
}

/** Counts suppressions in authored code files at the base and at committed HEAD, so a PR body copies them instead of typing them. */
export function revisionCounts(root: string, baseRef: string): string {
  const rows = revisionCountRows(root, baseRef);
  return `\nSuppressions in authored code files (${baseRef} and committed HEAD). A lint directive counts once per rule it names; \`*\` is a directive naming none.\n| Suppressions | base | HEAD |\n| --- | ---: | ---: |\n${rows.join("\n")}\n`;
}
