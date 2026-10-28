import { spawnSync } from "node:child_process";

import {
  atRevision,
  inWorktree,
  openDisablesIn,
  revisionSuppressions,
  worktreeSuppressions,
  type OpenDisable,
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

const MIN_REASON_WORDS = 3;

/** Words that say a suppression is wanted without saying why the code needs it. */
const VAGUE_WORDS = new Set(
  `a an the this that it its is are be was here there we for of to as and or not no
  ok okay fine safe safely correct valid works working intended intentional intentionally
  needed necessary required expected known false positive legacy existing old behavior behaviour
  preserve preserved preserves preserving keep kept compat compatibility workaround hack
  temporary todo fixme later ignore ignored disable disabled suppress suppressed lint rule
  type types typing typescript cast casting assert assertion by design trust trusted me`.split(
    /\s+/u,
  ),
);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** A reason too short or too vague to tell a reader why this code needs its suppression. */
function genericReason(suppression: Suppression): boolean {
  const said = words(suppression.reason);
  if (said.length < MIN_REASON_WORDS) return true;
  const named = new Set(
    suppression.kind === "rule" ? words(suppression.rule) : [],
  );
  return said.every((word) => VAGUE_WORDS.has(word) || named.has(word));
}

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

function label(suppression: Suppression): string {
  if (suppression.kind === "rule")
    return `\`${suppression.directive} ${suppression.rule}\``;
  if (suppression.kind === "safety") return "`SAFETY:`";
  return suppression.kind === "tsIgnore"
    ? "`@ts-ignore`"
    : "`@ts-expect-error`";
}

/**
 * Fails each added suppression that names a rule no directive may name, and
 * each whose reason is empty or generic. Suppressions already on the base
 * are left to the burn-down the budget tracks.
 */
function policyFailures(added: Suppression[]): string[] {
  return added.flatMap((suppression) => {
    const at = `${suppression.file}:${suppression.line}`;
    const instead =
      suppression.kind === "rule"
        ? NEVER_SUPPRESSED.get(suppression.rule)
        : undefined;
    if (instead !== undefined)
      return [
        `${at}: ${label(suppression)}: this rule is never suppressed. Fix: ${instead}.`,
      ];
    if (suppression.kind === "rule" && suppression.rule === "*") return [];
    if (!genericReason(suppression)) return [];
    const quoted = suppression.reason ? `"${suppression.reason}"` : "none";
    return [
      `${at}: ${label(suppression)} reason ${quoted} does not say why this code needs it. Fix: state the fact about this line that makes the suppression hold (at least ${MIN_REASON_WORDS} words${suppression.kind === "rule" ? ", after ` -- `" : ""}), or fix the code.`,
    ];
  });
}

/** Fails each block disable left open at the end of its file. */
function openDisableFailures(open: OpenDisable[]): string[] {
  return open.map(
    ({ directive, rule, file, line }) =>
      `${file}:${line}: \`${directive}${rule === "*" ? "" : ` ${rule}`}\` is never closed, so it also silences every line added below it. Fix: add \`${directive.replace("disable", "enable")}${rule === "*" ? "" : ` ${rule}`}\` right after the last line that needs it, or use \`${directive}-next-line\`.`,
  );
}

/** The open blocks of `after` beyond those of `before`, by directive and rule. */
function addedOpenDisables(
  before: OpenDisable[],
  after: OpenDisable[],
): OpenDisable[] {
  return unmatched(before, after, ({ directive, rule }) =>
    [directive, rule].join("\0"),
  );
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
 * given): a suppression that names a never-suppressed rule or gives no
 * specific reason, and a block disable left open.
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
    ...openDisableFailures(
      addedOpenDisables(
        atRevision(root, revision, openDisablesIn),
        inWorktree(root, openDisablesIn),
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
    ...openDisableFailures(
      addedOpenDisables(
        atRevision(root, "HEAD", openDisablesIn, previous),
        atRevision(root, "", openDisablesIn, staged),
      ),
    ),
  ];
}
