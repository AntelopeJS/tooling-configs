import assert from "node:assert/strict";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { ruleDocPath } from "../oxc/rule-docs.ts";
import {
  bin,
  commit,
  linkOxlint,
  put,
  testRepo,
  usePreset,
} from "./helpers/test-repo.ts";

const TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, noEmit: true, types: [] },
  include: ["src"],
});

const DEBUGGER_URL =
  "https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-debugger.html";

/** A repository on the shared preset: a comment and a `debugger` in `src/a.ts`, a comment and two `debugger` in `src/b.ts`, so the rule and file counts order by count where the names order the other way. */
function findingsRepo(t: TestContext): string {
  const root = testRepo(t);
  linkOxlint(root);
  usePreset(root);
  put(root, "tsconfig.json", TSCONFIG);
  put(root, "src/a.ts", "// first\nexport const a = 1;\n\ndebugger;\n");
  put(
    root,
    "src/b.ts",
    "export const b = 2;\n\n// second\nexport const c = 3;\n  debugger;\ndebugger;\n",
  );
  commit(root);
  return root;
}

function warningsRepo(t: TestContext): string {
  const root = testRepo(t);
  linkOxlint(root);
  put(
    root,
    ".oxlintrc.json",
    JSON.stringify({ rules: { "eslint/no-debugger": "warn" } }),
  );
  put(root, "src/a.ts", "debugger;\n");
  commit(root);
  return root;
}

test("prints the findings, then the rule counts, then the file counts, each block after one blank line, most frequent first", (t) => {
  const root = findingsRepo(t);
  const result = bin(root, "lint-summary");
  const blocks = result.stdout.trimEnd().split("\n\n");
  assert.equal(blocks.length, 3, result.stdout + result.stderr);
  const [findings, rules, files] = blocks.map((block) => block.split("\n"));
  assert.deepEqual(
    findings.map((line) => line.split(" ").slice(0, 2).join(" ")),
    [
      "src/a.ts:1:1 antelopejs/no-comments",
      "src/a.ts:4:1 eslint/no-debugger",
      "src/b.ts:3:1 antelopejs/no-comments",
      "src/b.ts:5:3 eslint/no-debugger",
      "src/b.ts:6:1 eslint/no-debugger",
    ],
  );
  assert.deepEqual(rules, [
    `3 eslint/no-debugger ${DEBUGGER_URL}`,
    `2 antelopejs/no-comments ${ruleDocPath("no-comments")}`,
  ]);
  assert.deepEqual(files, ["3 src/b.ts", "2 src/a.ts"]);
  assert.equal(result.status, 1);
});

test("strips the docs pointer from each finding line and shows the page once, in the rule block", (t) => {
  const root = findingsRepo(t);
  const { stdout } = bin(root, "lint-summary");
  const page = ruleDocPath("no-comments");
  assert.equal(stdout.split(page).length - 1, 1);
  assert.ok(
    stdout
      .split("\n")
      .filter((line) => line.includes("antelopejs/no-comments Comments"))
      .every((line) => !line.includes("Docs:")),
  );
});

test("shows the url oxlint gives a built-in rule, and its help on the finding line", (t) => {
  const root = findingsRepo(t);
  const { stdout } = bin(root, "lint-summary");
  const line = stdout
    .split("\n")
    .find((candidate) =>
      candidate.startsWith("src/a.ts:4:1 eslint/no-debugger"),
    );
  assert.match(line ?? "", /Remove the debugger statement$/u);
  assert.ok(stdout.includes(`3 eslint/no-debugger ${DEBUGGER_URL}`));
});

test("prints nothing and exits 0 when nothing is found", (t) => {
  const root = testRepo(t);
  linkOxlint(root);
  usePreset(root);
  put(root, "tsconfig.json", TSCONFIG);
  put(root, "src/a.ts", "export const a = 1;\n");
  commit(root);
  const result = bin(root, "lint-summary");
  assert.deepEqual(
    { stdout: result.stdout, stderr: result.stderr, status: result.status },
    { stdout: "", stderr: "", status: 0 },
  );
});

test("exits 0 when every finding is a warning, and still prints them", (t) => {
  const root = warningsRepo(t);
  const result = bin(root, "lint-summary");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^src\/a\.ts:1:1 eslint\/no-debugger /u);
});

test("lints only the named paths", (t) => {
  const root = findingsRepo(t);
  const { stdout } = bin(root, "lint-summary", [join("src", "b.ts")]);
  assert.ok(!stdout.includes("src/a.ts"), stdout);
  assert.ok(stdout.includes("3 src/b.ts"), stdout);
});

test("reads a named path from the directory it runs in", (t) => {
  const root = findingsRepo(t);
  const { stdout } = bin(join(root, "src"), "lint-summary", ["b.ts"]);
  assert.ok(stdout.includes("3 src/b.ts"), stdout);
});

test("fails on a named path that does not exist instead of printing nothing", (t) => {
  const root = findingsRepo(t);
  const result = bin(root, "lint-summary", [join("src", "c.ts")]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /c\.ts does not exist/u);
});
