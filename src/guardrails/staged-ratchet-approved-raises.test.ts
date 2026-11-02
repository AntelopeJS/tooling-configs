import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test, { type TestContext } from "node:test";

import { formatCeilings } from "./ceilings.ts";
import { bin, commit, linkOxlint, put, testRepo } from "./helpers/test-repo.ts";

const RULE = "typescript/no-explicit-any";
const LEGACY = "export const first: any = 1;\nexport const second: any = 2;\n";

function ratchetRepo(t: TestContext) {
  const root = testRepo(t);
  linkOxlint(root);
  put(
    root,
    ".oxlintrc.json",
    JSON.stringify({
      categories: { correctness: "off" },
      plugins: ["typescript"],
      rules: { [RULE]: "error" },
    }),
  );
  put(root, "source.ts", `export const keep = 0;\n${LEGACY}`);
  put(root, "other.ts", "export const other = 0;\n");
  writeCeiling(root, 2);
  commit(root);
  return root;
}

function writeCeiling(root: string, count: number): void {
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({ rules: { [RULE]: count }, oversizeFiles: {} }),
  );
}

function stageAdding(root: string, added: number, ceiling: number): void {
  const extra = Array.from(
    { length: added },
    (_, index) => `export const added${index}: any = ${index};\n`,
  ).join("");
  put(root, "source.ts", `export const keep = 0;\n${LEGACY}${extra}`);
  writeCeiling(root, ceiling);
  execFileSync("git", ["add", "-A"], { cwd: root });
}

function check(root: string, approved?: string) {
  return bin(
    root,
    "ratchet",
    ["--staged", "source.ts"],
    approved === undefined ? {} : { APPROVED_RAISES: approved },
  );
}

test("an approved rule within its maximum passes and the raise is printed loudly", (t) => {
  const root = ratchetRepo(t);
  stageAdding(root, 1, 3);
  const result = check(root, `${RULE}=3`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /APPROVED RAISE/);
  assert.match(result.stderr, new RegExp(`${RULE}.*3`));
});

test("an approved rule above its maximum is refused", (t) => {
  const root = ratchetRepo(t);
  stageAdding(root, 2, 3);
  const result = check(root, `${RULE}=3`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /APPROVED_RAISES/);
  assert.match(result.stderr, /4 findings.*at most 3/);
  assert.doesNotMatch(result.stderr, /APPROVED RAISE ACCEPTED/);
});

test("an approved maximum the staged ceiling does not equal is refused", (t) => {
  const root = ratchetRepo(t);
  stageAdding(root, 1, 2);
  const result = check(root, `${RULE}=3`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /APPROVED_RAISES/);
  assert.match(result.stderr, /guardrails\.ratchet\.json/);
});

test("a rule the variable does not list is refused", (t) => {
  const root = ratchetRepo(t);
  stageAdding(root, 1, 3);
  const result = check(root, "anti-slop/no-reflect-get=3");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /this commit adds 1 to the staged files/);
  assert.match(
    result.stderr,
    new RegExp(`APPROVED_RAISES does not list ${RULE}`),
  );
});

test("a malformed variable is refused even when the commit is clean", (t) => {
  const root = ratchetRepo(t);
  put(root, "other.ts", "export const other = 1;\n");
  execFileSync("git", ["add", "-A"], { cwd: root });
  for (const malformed of [
    RULE,
    `${RULE}=`,
    `${RULE}=two`,
    `${RULE}=-1`,
    `${RULE}=1.5`,
    `${RULE}=2 ${RULE}=3`,
    "=2",
    `${RULE}=1234567890123456`,
  ]) {
    const result = bin(root, "ratchet", ["--staged", "other.ts"], {
      APPROVED_RAISES: malformed,
    });
    assert.equal(result.status, 1, malformed);
    assert.match(result.stderr, /APPROVED_RAISES is malformed/, malformed);
  }
});

test("without the variable a raise is refused as before", (t) => {
  const root = ratchetRepo(t);
  stageAdding(root, 1, 3);
  for (const result of [check(root), check(root, "")]) {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /this commit adds 1 to the staged files/);
    assert.doesNotMatch(result.stderr, /APPROVED/);
  }
});
