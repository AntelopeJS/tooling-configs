import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  API_BUILD_SCRIPT,
  apiRepo,
  bin,
  commit,
  put,
  read,
  testRepo,
} from "./helpers/test-repo.ts";

test("comment-proof reads a nested package in a repository with no root manifest", (t) => {
  const root = testRepo(t);
  rmSync(join(root, "package.json"));
  put(
    root,
    "lib/package.json",
    JSON.stringify({ name: "lib", main: "dist/index.js" }),
  );
  put(
    root,
    "lib/tsconfig.json",
    JSON.stringify({ compilerOptions: { outDir: "dist" } }),
  );
  put(root, "lib/src/index.ts", "export const value = 1;\n");
  commit(root);
  const result = bin(root, "comment-proof", ["HEAD"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Comment proof: 1 packages/);
});

test("api-diff proves a public package a brace pattern lists, since the workspace expander does not model braces", (t) => {
  const root = apiRepo(t);
  put(root, "pnpm-workspace.yaml", "packages:\n  - '{lib,tools}'\n");
  put(root, "src/index.ts", "export const answer = 42;\n");
  put(
    root,
    "lib/package.json",
    JSON.stringify({
      name: "lib",
      type: "module",
      scripts: { build: API_BUILD_SCRIPT },
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      },
    }),
  );
  put(root, "lib/tsconfig.json", read(root, "tsconfig.json"));
  put(root, "lib/src/index.ts", "export const value = 1;\n");
  commit(root);
  const result = bin(root, "api-diff", ["HEAD"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /API: 2 packages, 2 entries unchanged/);
  assert.doesNotMatch(result.stdout, /skipped lib/);
});

const WORKSPACES = {
  "a pnpm workspace listing other packages": "packages:\n  - frontend-vue\n",
  "a pnpm workspace listing no packages": "allowBuilds:\n  lefthook: false\n",
};

for (const [layout, workspace] of Object.entries(WORKSPACES))
  test(`api-diff skips a public playground outside ${layout} and proves the root`, (t) => {
    const root = apiRepo(t);
    const { scripts: _build, ...manifest } = JSON.parse(
      read(root, "package.json"),
    );
    put(root, "package.json", JSON.stringify(manifest));
    put(root, "pnpm-workspace.yaml", workspace);
    put(root, "src/index.ts", "export const answer = 42;\n");
    put(
      root,
      "playground/package.json",
      JSON.stringify({
        name: "playground",
        main: "dist/index.js",
        scripts: { build: "exit 1" },
      }),
    );
    put(
      root,
      "playground/tsconfig.json",
      JSON.stringify({ compilerOptions: { outDir: "dist", noEmit: true } }),
    );
    put(root, "playground/src/index.ts", "export const app = 1;\n");
    commit(root);
    const result = bin(root, "api-diff", ["HEAD"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(
      result.stdout,
      /API: skipped playground, not a workspace package\./,
    );
    assert.doesNotMatch(result.stdout, /Execution error/);
  });
