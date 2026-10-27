import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { apiRepo, bin, commit, put } from "./helpers/test-repo.ts";

test("api-diff passes when inferred object members are emitted in another order, and prints the diff once a member type changes", (t) => {
  const root = apiRepo(t);
  put(
    root,
    "src/index.ts",
    "export interface Options { mono: boolean; badge?: string }\nexport const options: { mono: boolean; actions: string[] } = { mono: true, actions: [] };\n",
  );
  commit(root);
  execFileSync("git", ["tag", "base"], { cwd: root });
  put(
    root,
    "src/index.ts",
    "export interface Options { badge?: string; mono: boolean }\nexport const options: { actions: string[]; mono: boolean } = { mono: true, actions: [] };\n",
  );
  commit(root);
  const reordered = bin(root, "api-diff", ["base"]);
  assert.equal(reordered.status, 0, reordered.stdout + reordered.stderr);
  put(
    root,
    "src/index.ts",
    "export interface Options { badge?: string; mono: number }\nexport const options: { actions: string[]; mono: boolean } = { mono: true, actions: [] };\n",
  );
  commit(root);
  const changed = bin(root, "api-diff", ["base"]);
  assert.equal(changed.status, 1);
  assert.match(changed.stdout, /-.*mono: boolean/);
  assert.match(changed.stdout, /\+.*mono: number/);
});
