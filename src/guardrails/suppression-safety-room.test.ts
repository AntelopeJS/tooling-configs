import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { formatBudget } from "./suppression-budget.ts";
import {
  bin,
  commit,
  linkOxlint,
  put,
  read,
  testRepo,
  usePreset,
} from "./helpers/test-repo.ts";

const RULE = "anti-slop/require-safety-comment-for-type-assertion";

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

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

function stage(root: string): void {
  git(root, ["add", "-A"]);
}

test("turning a directive that disables the SAFETY rule into a SAFETY: comment passes without a raise, and --update moves its room to safety", (t) => {
  const root = testRepo(t);
  linkOxlint(root);
  usePreset(root);
  put(root, "server/session.ts", SESSION);
  put(root, "app/auth/useAuthFetch.ts", AUTH_FETCH);
  put(
    root,
    "guardrails.suppressions.json",
    formatBudget({
      rules: { [RULE]: 2 },
      tsExpectError: 0,
      tsIgnore: 0,
      safety: 0,
    }),
  );
  commit(root);
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
    rules: { [RULE]: 1 },
    tsExpectError: 0,
    tsIgnore: 0,
    safety: 1,
  });
  stage(root);
  assert.equal(bin(root, "suppressions", ["--staged"]).status, 0);
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
  stage(root);
  const staged = bin(root, "suppressions", ["--staged"]);
  assert.equal(staged.status, 1);
  assert.match(
    staged.stderr,
    /`SAFETY:` comments: this commit adds 2 to the staged files\./,
  );
});
