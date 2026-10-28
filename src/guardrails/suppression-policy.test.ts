import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { formatBudget } from "./suppression-budget.ts";
import { bin, commit, put, testRepo } from "./helpers/test-repo.ts";

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

function budgetRepo(
  t: Parameters<typeof testRepo>[0],
  files: Record<string, string>,
  rules: Record<string, number>,
): string {
  const root = testRepo(t);
  for (const [path, content] of Object.entries(files)) put(root, path, content);
  put(
    root,
    "guardrails.suppressions.json",
    formatBudget({ rules, tsExpectError: 0, tsIgnore: 0, safety: 1 }),
  );
  commit(root);
  return root;
}

function stage(root: string): void {
  execFileSync("git", ["add", "-A"], { cwd: root });
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
