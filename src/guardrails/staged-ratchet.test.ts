import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test, { type TestContext } from "node:test";

import { formatCeilings } from "./ceilings.ts";
import { bin, commit, linkOxlint, put, testRepo } from "./helpers/test-repo.ts";

const LEGACY_BLOCK =
  "export const first: any = 1;\nexport const second: any = 2;\n";

function stage(root: string, ...files: string[]): void {
  execFileSync("git", ["add", "-A", "--", ...files], { cwd: root });
}

function ratchetRepo(t: TestContext) {
  const root = testRepo(t);
  linkOxlint(root);
  put(
    root,
    ".oxlintrc.json",
    JSON.stringify({
      categories: { correctness: "off" },
      plugins: ["typescript"],
      rules: { "typescript/no-explicit-any": "error" },
    }),
  );
  put(root, "source.ts", `export const keep = 0;\n${LEGACY_BLOCK}`);
  put(root, "target.ts", "export const target = 0;\n");
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({
      rules: { "typescript/no-explicit-any": 2 },
      oversizeFiles: {},
    }),
  );
  commit(root);
  return root;
}

function check(root: string, ...files: string[]) {
  return bin(root, "ratchet", ["--staged", ...files]);
}

test("staged ratchet passes a block with legacy findings moved between two files", (t) => {
  const root = ratchetRepo(t);
  put(root, "source.ts", "export const keep = 0;\n");
  put(root, "target.ts", `export const target = 0;\n${LEGACY_BLOCK}`);
  stage(root, "source.ts", "target.ts");
  const result = check(root, "source.ts", "target.ts");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(check(root).status, 0);
});

test("staged ratchet passes legacy findings moved into a new file whose source is deleted", (t) => {
  const root = ratchetRepo(t);
  put(root, "source.ts", "export const keep = 0;\n");
  put(root, "moved/target.ts", LEGACY_BLOCK);
  execFileSync("git", ["rm", "-q", "--cached", "target.ts"], { cwd: root });
  stage(root, "source.ts", "moved/target.ts");
  const result = check(root, "source.ts", "moved/target.ts");
  assert.equal(result.status, 0, result.stderr);
});

test("staged ratchet passes a reformatted legacy line", (t) => {
  const root = ratchetRepo(t);
  put(
    root,
    "source.ts",
    "export const keep = 0;\nexport const first: any =\n  1;\nexport const second: any = 2;\n",
  );
  stage(root, "source.ts");
  const result = check(root, "source.ts");
  assert.equal(result.status, 0, result.stderr);
});

test("staged ratchet fails a finding added next to legacy ones", (t) => {
  const root = ratchetRepo(t);
  put(
    root,
    "source.ts",
    `export const keep = 0;\n${LEGACY_BLOCK}export const third: any = 3;\n`,
  );
  stage(root, "source.ts");
  const result = check(root, "source.ts");
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /typescript\/no-explicit-any: this commit adds 1 to the staged files \(2 at HEAD, 3 staged\)/,
  );
  assert.match(result.stderr, /source\.ts:4:/);
  assert.doesNotMatch(result.stderr, /source\.ts:2:/);
});

test("staged ratchet fails a move that also adds a finding", (t) => {
  const root = ratchetRepo(t);
  put(root, "source.ts", "export const keep = 0;\n");
  put(
    root,
    "target.ts",
    `export const target = 0;\n${LEGACY_BLOCK}export const third: any = 3;\n`,
  );
  stage(root, "source.ts", "target.ts");
  const result = check(root, "source.ts", "target.ts");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /this commit adds 1 to the staged files/);
});

test("staged ratchet fails a finding in a new file that has no HEAD counterpart", (t) => {
  const root = ratchetRepo(t);
  put(root, "extra.ts", "export const extra: any = 1;\n");
  stage(root, "extra.ts");
  const result = check(root, "extra.ts");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /extra\.ts:1:/);
});
