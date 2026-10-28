import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { formatBudget } from "./suppression-budget.ts";
import { bin, commit, put, read, testRepo } from "./helpers/test-repo.ts";

const SESSION = [
  "export function statusOf(error: Error) {",
  "  // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- This unchecked status access preserves existing thrown-value handling, including a TypeError for nullish errors; no validated owner exists.",
  "  return (error as { status?: number }).status;",
  "}",
  "",
].join("\n");

const AUTH_FETCH = [
  "export function codeOf(error: Error) {",
  "  // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- This unchecked optional access preserves primitive boxing and nested getter behavior; a schema guard would change malformed-input behavior.",
  "  return (error as { code?: string }).code;",
  "}",
  "",
].join("\n");

const NUMBERS = (reason: string) =>
  [
    "export function expectDate(parsed: Date | string) {",
    "  if (!(parsed instanceof Date))",
    "    throw new Error(",
    `      // oxlint-disable-next-line anti-slop/no-runtime-typeof${reason}`,
    "      `Date filter expects a date value. Got: ${typeof parsed}`,",
    "    );",
    "}",
    "",
  ].join("\n");

const ACCESSIBILITY = (enable: boolean) =>
  [
    "/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- The decoded cookie has no validated field contract; this open property lookup implements per-field fallback without rejecting the entire cookie. */",
    "export function isRecord(value: object): value is Record<string, unknown> {",
    "  return value !== null && !Array.isArray(value);",
    "}",
    ...(enable
      ? ["/* oxlint-enable anti-slop/no-unsafe-dictionary-type */"]
      : []),
    "export const later: Record<string, unknown> = {};",
    "",
  ].join("\n");

function budgetRepo(
  t: Parameters<typeof testRepo>[0],
  files: Record<string, string>,
  rules: Record<string, number>,
  safety = 1,
): string {
  const root = testRepo(t);
  for (const [path, content] of Object.entries(files)) put(root, path, content);
  put(
    root,
    "guardrails.suppressions.json",
    formatBudget({ rules, tsExpectError: 0, tsIgnore: 0, safety }),
  );
  commit(root);
  return root;
}

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

function stage(root: string): void {
  git(root, ["add", "-A"]);
}

test("a new directive disabling the SAFETY rule fails within the budget and names the fix; the one already on the base and a move with its reason pass", (t) => {
  const root = budgetRepo(
    t,
    { "server/session.ts": SESSION },
    { "anti-slop/require-safety-comment-for-type-assertion": 1 },
  );
  assert.equal(bin(root, "suppressions").status, 0);
  put(root, "server/session.ts", "export const statusOf = 1;\n");
  put(root, "app/auth/useAuthFetch.ts", AUTH_FETCH);
  const swapped = bin(root, "suppressions");
  assert.equal(swapped.status, 1);
  assert.match(
    swapped.stderr,
    /^app\/auth\/useAuthFetch\.ts:2: `oxlint-disable-next-line anti-slop\/require-safety-comment-for-type-assertion`: this rule is never suppressed\. Fix: remove the assertion \(a type guard, a schema parse at the boundary, an inferred or owner-derived type\), or, where it really holds, write `SAFETY: <why it holds>` above it\.$/m,
  );
  stage(root);
  assert.equal(bin(root, "suppressions", ["--staged"]).status, 1);
  put(root, "app/auth/useAuthFetch.ts", "export const codeOf = 1;\n");
  put(root, "server/errors/session.ts", SESSION);
  stage(root);
  const moved = bin(root, "suppressions");
  assert.equal(moved.status, 0, moved.stderr);
  assert.equal(bin(root, "suppressions", ["--staged"]).status, 0);
});

test("an added directive with no reason or a one-word reason fails, and a stripped reason counts as added where it was stripped", (t) => {
  const reasoned = NUMBERS(
    " -- the message reports the runtime kind of the rejected value",
  );
  const root = budgetRepo(
    t,
    { "src/numbers.ts": reasoned, "src/legacy.ts": NUMBERS("") },
    { "anti-slop/no-runtime-typeof": 2 },
  );
  assert.equal(bin(root, "suppressions").status, 0);
  put(root, "src/numbers.ts", NUMBERS(" -- Diagnostic."));
  const vague = bin(root, "suppressions");
  assert.equal(vague.status, 1);
  assert.match(
    vague.stderr,
    /^src\/numbers\.ts:4: `oxlint-disable-next-line anti-slop\/no-runtime-typeof` reason "Diagnostic\." does not say why this code needs it\. Fix: state the fact about this line that makes the suppression hold \(at least 3 words, after ` -- `\), or fix the code\.$/m,
  );
  put(root, "src/numbers.ts", NUMBERS(""));
  assert.match(
    bin(root, "suppressions").stderr,
    /^src\/numbers\.ts:4: `oxlint-disable-next-line anti-slop\/no-runtime-typeof` reason none[^\n]*\n(?!src\/legacy)/,
  );
  put(
    root,
    "src/numbers.ts",
    NUMBERS(" -- intentional legacy behaviour, safe"),
  );
  assert.match(bin(root, "suppressions").stderr, /does not say why/);
  put(root, "src/numbers.ts", reasoned);
  assert.equal(bin(root, "suppressions").status, 0);
});

test("a vague SAFETY: or @ts-expect-error reason fails like a directive's", (t) => {
  const root = budgetRepo(t, { "src/index.ts": "export {};\n" }, {});
  put(
    root,
    "src/index.ts",
    [
      "// SAFETY: safe cast",
      "export const id = JSON.parse('1') as number;",
      "// @ts-expect-error",
      "export const total: number = 'total';",
      "",
    ].join("\n"),
  );
  put(
    root,
    "guardrails.suppressions.json",
    formatBudget({ rules: {}, tsExpectError: 1, tsIgnore: 0, safety: 1 }),
  );
  const result = bin(root, "suppressions");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/index\.ts:1: `SAFETY:` reason "safe cast"/);
  assert.match(
    result.stderr,
    /src\/index\.ts:3: `@ts-expect-error` reason none/,
  );
});

test("a block disable left open to the end of its file fails, and closing it right after its last use passes", (t) => {
  const path = "app/build/utils/accessibilityPreferences.ts";
  const root = budgetRepo(
    t,
    { [path]: ACCESSIBILITY(true) },
    { "anti-slop/no-unsafe-dictionary-type": 1 },
  );
  put(root, path, ACCESSIBILITY(false));
  const open = bin(root, "suppressions");
  assert.equal(open.status, 1);
  assert.match(
    open.stderr,
    /^app\/build\/utils\/accessibilityPreferences\.ts:1: `oxlint-disable anti-slop\/no-unsafe-dictionary-type` is never closed, so it also silences every line added below it\. Fix: add `oxlint-enable anti-slop\/no-unsafe-dictionary-type` right after the last line that needs it, or use `oxlint-disable-next-line`\.$/m,
  );
  stage(root);
  assert.equal(bin(root, "suppressions", ["--staged"]).status, 1);
  put(root, path, ACCESSIBILITY(true));
  stage(root);
  assert.equal(bin(root, "suppressions").status, 0);
  assert.equal(bin(root, "suppressions", ["--staged"]).status, 0);
});

test("turning a directive that disables the SAFETY rule into a SAFETY: comment passes without a raise, and --update moves its room to safety", (t) => {
  const rule = "anti-slop/require-safety-comment-for-type-assertion";
  const root = budgetRepo(
    t,
    { "server/session.ts": SESSION, "app/auth/useAuthFetch.ts": AUTH_FETCH },
    { [rule]: 2 },
    0,
  );
  git(root, ["branch", "base"]);
  const safety = SESSION.replace(
    /\/\/ oxlint-disable-next-line \S+ -- /u,
    "// SAFETY: ",
  );
  put(root, "server/session.ts", safety);
  stage(root);
  assert.equal(bin(root, "suppressions", ["--staged"]).status, 0);
  const converted = bin(root, "suppressions", ["--base", "base"]);
  assert.equal(converted.status, 0, converted.stderr);
  assert.equal(bin(root, "suppressions", ["--update"]).status, 0);
  assert.deepEqual(JSON.parse(read(root, "guardrails.suppressions.json")), {
    rules: { [rule]: 1 },
    tsExpectError: 0,
    tsIgnore: 0,
    safety: 1,
  });
  const lowered = bin(root, "suppressions", ["--base", "base"]);
  assert.equal(lowered.status, 0, lowered.stderr);
  put(
    root,
    "src/extra.ts",
    "// SAFETY: the parsed config is a plain object\nexport const config = JSON.parse('{}') as object;\n",
  );
  const added = bin(root, "suppressions", ["--base", "base"]);
  assert.equal(added.status, 1);
  assert.match(added.stderr, /`SAFETY:` comments: 2 exceeds ceiling 1\./);
});
