import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { formatCeilings, readCeilings } from "./ceilings.ts";
import { measureBaseline } from "./ratchet.ts";
import {
  bin,
  commit,
  linkOxlint,
  PACKAGE_ROOT,
  put,
  testRepo,
} from "./helpers/test-repo.ts";

function lintRepo(t: Parameters<typeof testRepo>[0]): string {
  const root = testRepo(t);
  linkOxlint(root);
  put(
    root,
    ".oxlintrc.json",
    JSON.stringify({
      categories: { correctness: "off" },
      plugins: ["typescript"],
      rules: {
        "eslint/max-params": ["error", { max: 1 }],
        "typescript/no-explicit-any": "error",
        "eslint/max-lines": ["error", { max: 10 }],
      },
    }),
  );
  return root;
}

test("baseline maps real eslint, typescript and JS plugin codes to config ids, not raw codes", (t) => {
  const root = lintRepo(t);
  put(
    root,
    ".oxlintrc.json",
    JSON.stringify({
      categories: { correctness: "off" },
      plugins: ["typescript"],
      jsPlugins: [
        {
          name: "anti-slop",
          specifier: join(PACKAGE_ROOT, "src/oxc/anti-slop/index.ts"),
        },
      ],
      rules: {
        "eslint/max-params": ["error", { max: 1 }],
        "typescript/no-explicit-any": "error",
        "anti-slop/no-object-parameters": "error",
      },
    }),
  );
  put(
    root,
    "sample.ts",
    "export function pair(a: string, b: string): string { return a + b; }\nexport let value: any;\nexport function options(input: object): object { return input; }\n",
  );
  assert.deepEqual(measureBaseline(root), {
    rules: {
      "eslint/max-params": 1,
      "typescript/no-explicit-any": 1,
      "anti-slop/no-object-parameters": 1,
    },
    oversizeFiles: {},
  });
});

test("ratchet fails a rise, points at the changed file's finding, and update lowers without raising or adding", (t) => {
  const root = lintRepo(t);
  put(root, "a.ts", "export function pair(a, b) { return [a, b]; }\n");
  put(root, "z.ts", "export const value = 1;\n");
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({
      rules: {
        "eslint/max-params": 1,
        "typescript/no-explicit-any": 2,
        "eslint/no-alert": 3,
      },
      oversizeFiles: {},
    }),
  );
  commit(root);
  put(
    root,
    "z.ts",
    "export function pair(a, b) { return [a, b]; }\nexport let value: any;\n",
  );
  const check = bin(root, "ratchet");
  assert.equal(check.status, 1);
  assert.match(
    check.stderr,
    /eslint\/max-params: 2 diagnostics exceeds ceiling 1/,
  );
  assert.match(check.stderr, /^ {2}z\.ts:1:\d+: /m);
  assert.doesNotMatch(check.stderr, /^ {2}a\.ts:/m);
  assert.match(
    check.stderr,
    /and 1 recorded in files this change does not touch/,
  );
  const update = bin(root, "ratchet", ["--update"]);
  assert.equal(update.status, 1);
  assert.match(update.stdout, /Lowered typescript\/no-explicit-any: 2 -> 1/);
  assert.deepEqual(readCeilings(root).rules, {
    "eslint/max-params": 1,
    "typescript/no-explicit-any": 1,
  });
  put(root, "a.ts", "export const value = 1;\n");
  assert.equal(bin(root, "ratchet").status, 0);
  put(root, "new.ts", "export function third(a, b) { return [a, b]; }\n");
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({ rules: {}, oversizeFiles: {} }),
  );
  assert.equal(bin(root, "ratchet", ["--update"]).status, 1);
  assert.deepEqual(readCeilings(root).rules, {});
});

test("max-lines is file debt, not a global rule count; update keeps, lowers, drops and never adds file allowances", (t) => {
  const root = lintRepo(t);
  const long = Array.from(
    { length: 14 },
    (_, i) => `export const x${i} = ${i};`,
  ).join("\n");
  put(root, "long.ts", long);
  put(root, "byte-heavy.ts", `export const value = "${"x".repeat(20_000)}";\n`);
  const baseline = measureBaseline(root);
  assert.deepEqual(baseline.rules, {});
  assert.deepEqual(baseline.oversizeFiles, {
    "long.ts": Buffer.byteLength(long),
    "byte-heavy.ts": 20_025,
  });
  put(root, "guardrails.ratchet.json", formatCeilings(baseline));
  assert.equal(bin(root, "ratchet").status, 0);
  put(root, "long.ts", `${long}\nexport const next = 1;`);
  assert.equal(bin(root, "ratchet", ["--update"]).status, 1);
  assert.equal(
    readCeilings(root).oversizeFiles["long.ts"],
    Buffer.byteLength(long),
  );
  put(root, "long.ts", long.replace("export const x13 = 13;", ""));
  const lower = bin(root, "ratchet", ["--update"]);
  assert.equal(lower.status, 0, lower.stderr);
  assert.ok(
    readCeilings(root).oversizeFiles["long.ts"] < Buffer.byteLength(long),
  );
  put(root, "long.ts", "export const value = 1;\n");
  rmSync(join(root, "byte-heavy.ts"));
  assert.equal(bin(root, "ratchet", ["--update"]).status, 0);
  assert.deepEqual(readCeilings(root).oversizeFiles, {});
  assert.equal(existsSync(join(root, "guardrails.ratchet.json")), false);
  put(root, "new.ts", long);
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({ rules: {}, oversizeFiles: {} }),
  );
  const reject = bin(root, "ratchet", ["--update"]);
  assert.equal(reject.status, 1);
  assert.match(reject.stderr, /new.ts:.*max-lines/);
  assert.deepEqual(readCeilings(root).oversizeFiles, {});
  assert.equal(bin(root, "ratchet").status, 1);
  assert.equal(existsSync(join(root, "guardrails.ratchet.json")), false);
});

test("ratchet includes untracked findings among changed files and never reports zero to zero as lowering", (t) => {
  const root = lintRepo(t);
  put(root, "legacy.ts", "export let legacy: any;\n");
  put(root, "changed.ts", "export const before = 1;\n");
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({
      rules: { "typescript/no-explicit-any": 1, "eslint/no-alert": 0 },
      oversizeFiles: {},
    }),
  );
  commit(root);
  put(root, "changed.ts", "export let changed: any;\n");
  put(root, "untracked.ts", "export let untracked: any;\n");
  const result = bin(root, "ratchet", ["--update"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /untracked.ts:1:/);
  assert.doesNotMatch(result.stderr, /^ {2}legacy.ts:/m);
  assert.doesNotMatch(result.stdout, /0 -> 0/);
});

test("staged ratchet blocks newly added comments under a ceiling but passes untouched legacy comments", (t) => {
  const root = testRepo(t);
  linkOxlint(root);
  put(
    root,
    "oxlint.config.ts",
    `export default { categories: { correctness: "off" }, jsPlugins: [{ name: "antelopejs", specifier: ${JSON.stringify(join(PACKAGE_ROOT, "src/oxc/guardrails/index.ts"))} }], rules: { "antelopejs/no-comments": process.env.ANTELOPEJS_RATCHET_MEASURE === "1" ? "error" : "off" } };\n`,
  );
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({
      rules: { "antelopejs/no-comments": 10 },
      oversizeFiles: {},
    }),
  );
  put(root, "sample.ts", "// Legacy comment\nexport const value = 1;\n");
  commit(root);
  put(root, "sample.ts", "// Legacy comment\nexport const value = 2;\n");
  execFileSync("git", ["add", "sample.ts"], { cwd: root });
  const unchanged = bin(root, "ratchet", ["--staged", "sample.ts"]);
  assert.equal(unchanged.status, 0, unchanged.stderr);
  put(
    root,
    "sample.ts",
    "// Legacy comment\nexport const value = 2;\n// New comment\n",
  );
  execFileSync("git", ["add", "sample.ts"], { cwd: root });
  const added = bin(root, "ratchet", ["--staged", "sample.ts"]);
  assert.equal(added.status, 1);
  assert.match(added.stderr, /sample.ts:3:1:.*comment/i);
  assert.match(added.stderr, /antelopejs\/no-comments/);
  assert.match(added.stderr, /TSDoc|code/);
  assert.doesNotMatch(added.stderr, /sample.ts:1:1:/);
});

test("staged ratchet passes when oxlint ignores every staged file but still fails on a parse error", (t) => {
  const root = lintRepo(t);
  put(
    root,
    ".oxlintrc.json",
    JSON.stringify({ ignorePatterns: ["ignored/**"] }),
  );
  put(root, "ignored/sample.ts", "export const value = 1;\n");
  commit(root);
  put(root, "ignored/sample.ts", "export const value = 2;\n");
  execFileSync("git", ["add", "ignored/sample.ts"], { cwd: root });
  const ignored = bin(root, "ratchet", ["--staged", "ignored/sample.ts"]);
  assert.equal(ignored.status, 0, ignored.stderr);
  put(root, "broken.ts", "let = ;\n");
  execFileSync("git", ["add", "broken.ts"], { cwd: root });
  const broken = bin(root, "ratchet", ["--staged", "broken.ts"]);
  assert.notEqual(broken.status, 0);
  assert.match(broken.stderr, /parser or configuration errors/);
});

test("ratchet removes zero ceilings without claiming a lowering from zero to zero", (t) => {
  const root = lintRepo(t);
  put(root, "sample.ts", "export const value = 1;\n");
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({ rules: { "eslint/no-alert": 0 }, oversizeFiles: {} }),
  );
  const result = bin(root, "ratchet", ["--update"]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /0 -> 0/);
  assert.deepEqual(readCeilings(root).rules, {});
  assert.equal(existsSync(join(root, "guardrails.ratchet.json")), false);
  assert.match(
    result.stdout,
    /Deleted guardrails\.ratchet\.json.*no debt left.*antelopejs-sync/,
  );
});

test("ratchet ignores growth of listed JSON and binary files and drops their allowances on update", (t) => {
  const root = lintRepo(t);
  put(root, "locales/en.json", JSON.stringify("x".repeat(21_000)));
  put(
    root,
    "packages/dms/docs-data/examples.json",
    JSON.stringify("x".repeat(48_000)),
  );
  put(root, "opaque.custom", `\0${"x".repeat(21_000)}`);
  put(root, "legacy.ts", "export let legacy: any;\n");
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({
      rules: { "typescript/no-explicit-any": 1 },
      oversizeFiles: {
        "locales/en.json": 20_001,
        "packages/dms/docs-data/examples.json": 48_123,
        "opaque.custom": 20_001,
      },
    }),
  );
  const result = bin(root, "ratchet", ["--update"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readCeilings(root), {
    pack: "0.2.17",
    rules: { "typescript/no-explicit-any": 1 },
    oversizeFiles: {},
  });
});

test("ratchet update keeps an oversize code allowance while dropping the JSON one", (t) => {
  const root = lintRepo(t);
  put(root, "docs-data/examples.json", JSON.stringify("x".repeat(48_000)));
  put(root, "big.ts", `export const big = "${"x".repeat(21_000)}";\n`);
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({
      rules: {},
      oversizeFiles: { "docs-data/examples.json": 48_123, "big.ts": 22_000 },
    }),
  );
  const result = bin(root, "ratchet", ["--update"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(Object.keys(readCeilings(root).oversizeFiles), ["big.ts"]);
});
