import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import { lintProject } from "../oxc/helpers/lint-project.ts";
import { formatCeilings, readCeilings } from "./ceilings.ts";
import { bin, commit, linkOxlint, put, testRepo } from "./helpers/test-repo.ts";

const LEGACY = "src/core/manager.ts";
const MOVED = "src/core/modules/manager.ts";

function lines(count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `export const value${i} = ${i * 7919};`,
  ).join("\n");
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root });
}

function move(root: string, from: string, to: string): void {
  mkdirSync(dirname(join(root, to)), { recursive: true });
  git(root, "mv", from, to);
}

function allowlistedRepo(t: TestContext, source = lines(14)) {
  const root = testRepo(t);
  linkOxlint(root);
  put(
    root,
    ".oxlintrc.json",
    JSON.stringify({
      categories: { correctness: "off" },
      rules: { "eslint/max-lines": ["error", { max: 10 }] },
    }),
  );
  put(root, LEGACY, source);
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({
      rules: {},
      oversizeFiles: { [LEGACY]: Buffer.byteLength(source) },
    }),
  );
  commit(root);
  return { root, size: Buffer.byteLength(source) };
}

test("a renamed oversize file keeps its allowance and update moves it and tightens it", (t) => {
  const { root, size } = allowlistedRepo(t);
  move(root, LEGACY, MOVED);
  put(root, MOVED, lines(13));
  git(root, "add", MOVED);
  const check = bin(root, "ratchet");
  assert.equal(check.status, 0, check.stderr);
  const update = bin(root, "ratchet", ["--update"]);
  assert.equal(update.status, 0, update.stderr);
  const { oversizeFiles } = readCeilings(root);
  assert.deepEqual(Object.keys(oversizeFiles), [MOVED]);
  assert.ok(oversizeFiles[MOVED] < size);
  assert.equal(oversizeFiles[MOVED], Buffer.byteLength(lines(13)));
});

test("a renamed oversize file that grows fails and update never raises its allowance", (t) => {
  const { root, size } = allowlistedRepo(t);
  move(root, LEGACY, MOVED);
  put(root, MOVED, `${lines(14)}\nexport const extra = 1;`);
  git(root, "add", MOVED);
  const check = bin(root, "ratchet");
  assert.equal(check.status, 1);
  assert.match(
    check.stderr,
    /src\/core\/modules\/manager\.ts: \d+ bytes, 24 bytes over the \d+-byte ceiling/,
  );
  const update = bin(root, "ratchet", ["--update"]);
  assert.equal(update.status, 1);
  assert.deepEqual(readCeilings(root).oversizeFiles, { [MOVED]: size });
});

test("a copy and a new file inherit no allowance, even beside an allowlisted original", (t) => {
  const { root } = allowlistedRepo(t);
  put(root, "src/core/copy.ts", lines(14));
  put(root, "src/core/fresh.ts", lines(14).replaceAll("7919", "104729"));
  git(root, "add", "src");
  const check = bin(root, "ratchet");
  assert.equal(check.status, 1);
  assert.match(check.stderr, /src\/core\/copy\.ts: /);
  assert.match(check.stderr, /src\/core\/fresh\.ts: /);
  assert.doesNotMatch(check.stderr, /src\/core\/manager\.ts: /);
  assert.deepEqual(Object.keys(readCeilings(root).oversizeFiles), [LEGACY]);
});

test("a renamed file with only a different body is a new file", (t) => {
  const { root } = allowlistedRepo(t);
  git(root, "rm", "-q", LEGACY);
  put(root, MOVED, lines(14).replaceAll("7919", "104729"));
  git(root, "add", MOVED);
  const check = bin(root, "ratchet");
  assert.equal(check.status, 1);
  assert.match(check.stderr, /modules\/manager\.ts: /);
});

test("size and the staged ratchet accept a staged rename of an allowlisted file", (t) => {
  const big = `${lines(900)}\ndebugger;\n`;
  const { root } = allowlistedRepo(t, big);
  put(
    root,
    ".oxlintrc.json",
    JSON.stringify({
      categories: { correctness: "off" },
      rules: { "eslint/no-debugger": "error" },
    }),
  );
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({
      rules: { "eslint/no-debugger": 5 },
      oversizeFiles: { [LEGACY]: Buffer.byteLength(big) },
    }),
  );
  commit(root);
  move(root, LEGACY, MOVED);
  assert.equal(bin(root, "check-size", ["--staged", MOVED]).status, 0);
  assert.equal(bin(root, "check-size").status, 0);
  const staged = bin(root, "ratchet", ["--staged", MOVED]);
  assert.equal(staged.status, 0, staged.stderr);
  put(root, MOVED, `${big}export const grown = 1;\n`);
  git(root, "add", MOVED);
  assert.equal(bin(root, "check-size", ["--staged", MOVED]).status, 1);
});

test("a rename committed earlier is carried when the ratchet compares against a base revision", (t) => {
  const { root } = allowlistedRepo(t);
  move(root, LEGACY, MOVED);
  commit(root);
  assert.equal(bin(root, "ratchet").status, 1);
  const since = bin(root, "ratchet", ["--base", "HEAD~1", "--update"]);
  assert.equal(since.status, 0, since.stderr);
  assert.deepEqual(Object.keys(readCeilings(root).oversizeFiles), [MOVED]);
  assert.equal(bin(root, "ratchet", ["--base", "--bogus"]).status, 1);
});

test("lint turns max-lines off for the new path of a renamed allowlisted file only", () => {
  const project = lintProject();
  try {
    const source = Array.from(
      { length: 505 },
      (_, i) => `export const item${i} = ${i};`,
    ).join("\n");
    project.write(LEGACY, source);
    project.write(
      "guardrails.ratchet.json",
      formatCeilings({ rules: {}, oversizeFiles: { [LEGACY]: 40_000 } }),
    );
    git(project.root, "init", "-q");
    commit(project.root);
    move(project.root, LEGACY, MOVED);
    project.write("src/core/copy.ts", `${source}\nexport const copied = 1;`);
    git(project.root, "add", "src");
    const result = project.run();
    assert.deepEqual(
      result.diagnostics.map(
        (diagnostic: { filename: string }) => diagnostic.filename,
      ),
      ["src/core/copy.ts"],
      JSON.stringify(result),
    );
  } finally {
    project.remove();
  }
});
