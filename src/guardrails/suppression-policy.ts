import { spawnSync } from "node:child_process";

import {
  revisionSuppressions,
  worktreeSuppressions,
  type Suppression,
} from "./suppressions.ts";

/** Rules a directive may never name, each with what to do instead. */
const NEVER_SUPPRESSED: ReadonlyMap<string, string> = new Map([
  [
    "anti-slop/require-safety-comment-for-type-assertion",
    "remove the assertion (a type guard, a schema parse at the boundary, an inferred or owner-derived type), or, where it really holds, write `SAFETY: <why it holds>` above it",
  ],
  [
    "antelopejs/no-comments",
    "say it in code, move a public contract into TSDoc, or delete the comment",
  ],
  [
    "antelopejs/no-constant-value-assertion",
    "assert on a value the code under test computes, or delete the test",
  ],
  [
    "antelopejs/no-fs-read-in-tests",
    "drive the behaviour through the public interface, or read from fixtures/",
  ],
  [
    "antelopejs/no-typeof-function-only-test",
    "assert on what the function returns or does, or delete the test",
  ],
  [
    "antelopejs/require-assertion",
    "assert on the behaviour, or delete the test",
  ],
  ["typescript/ban-ts-comment", "use `@ts-expect-error <reason>`"],
]);

function identity(suppression: Suppression): string {
  return [
    suppression.kind,
    suppression.kind === "rule" ? suppression.rule : "",
    suppression.reason,
  ].join("\0");
}

/** Takes one occurrence of `key` from `counts`, reporting whether one was left. */
function take(counts: Map<string, number>, key: string): boolean {
  const left = counts.get(key) ?? 0;
  if (left > 0) counts.set(key, left - 1);
  return left > 0;
}

/**
 * The items of `after` that `before` does not account for, as multisets of
 * `key`: an item is matched first in its own file, then in any file, so a
 * moved item is not added and an added one is reported where it was added.
 */
function unmatched<T extends { file: string }>(
  before: T[],
  after: T[],
  key: (item: T) => string,
): T[] {
  const sameFile = new Map<string, number>();
  for (const item of before) {
    const local = `${item.file}\0${key(item)}`;
    sameFile.set(local, (sameFile.get(local) ?? 0) + 1);
  }
  const elsewhere = after.filter(
    (item) => !take(sameFile, `${item.file}\0${key(item)}`),
  );
  const anyFile = new Map<string, number>();
  for (const [local, count] of sameFile) {
    const global = local.slice(local.indexOf("\0") + 1);
    anyFile.set(global, (anyFile.get(global) ?? 0) + count);
  }
  return elsewhere.filter((item) => !take(anyFile, key(item)));
}

/**
 * The suppressions of `after` that `before` does not account for, by kind,
 * rule and reason, so a suppression moved to another file with its reason is
 * not added, and one whose reason changed is.
 */
function addedSuppressions(
  before: Suppression[],
  after: Suppression[],
): Suppression[] {
  return unmatched(before, after, identity);
}

/**
 * Fails each added suppression that names a rule no directive may name.
 * Suppressions already on the base are left to the burn-down the budget
 * tracks.
 */
function policyFailures(added: Suppression[]): string[] {
  return added.flatMap((suppression) => {
    if (suppression.kind !== "rule") return [];
    const instead = NEVER_SUPPRESSED.get(suppression.rule);
    return instead === undefined
      ? []
      : [
          `${suppression.file}:${suppression.line}: \`${suppression.directive} ${suppression.rule}\`: this rule is never suppressed. Fix: ${instead}.`,
        ];
  });
}

function hasCommit(root: string, revision: string): boolean {
  return (
    spawnSync(
      "git",
      ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`],
      { cwd: root },
    ).status === 0
  );
}

/**
 * Fails what the working tree adds against `revision` (HEAD when none is
 * given): a suppression that names a never-suppressed rule.
 */
export function checkPolicy(root: string, revision = "HEAD"): string[] {
  if (!hasCommit(root, revision)) return [];
  return [
    ...policyFailures(
      addedSuppressions(
        revisionSuppressions(root, revision),
        worktreeSuppressions(root),
      ),
    ),
  ];
}

/** The same policy for a commit: the staged files against their HEAD versions, rename sources and deleted files included. */
export function checkStagedPolicy(
  root: string,
  staged: string[],
  previous: string[],
): string[] {
  if (!hasCommit(root, "HEAD")) return [];
  return [
    ...policyFailures(
      addedSuppressions(
        revisionSuppressions(root, "HEAD", previous),
        revisionSuppressions(root, "", staged),
      ),
    ),
  ];
}
