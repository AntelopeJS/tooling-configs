import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  bin,
  commit,
  PACKAGE_ROOT,
  put,
  testRepo,
} from "./helpers/test-repo.ts";

function apiRepo(t: Parameters<typeof testRepo>[0]): string {
  const root = testRepo(t);
  symlinkSync(
    join(PACKAGE_ROOT, "node_modules"),
    join(root, "node_modules"),
    "dir",
  );
  put(
    root,
    "package.json",
    JSON.stringify({
      name: "public-api",
      type: "module",
      exports: { ".": { types: "./dist/index.d.ts", default: "./unbuilt.js" } },
    }),
  );
  put(
    root,
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2020",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        rootDir: "src",
        outDir: "dist",
        types: [],
        strict: true,
        noEmit: true,
        declarationMap: true,
        composite: true,
      },
      include: ["src/**/*"],
    }),
  );
  return root;
}

test("api-diff ignores internal moves, declaration order and TSDoc, but detects an exported signature change in committed HEAD", (t) => {
  const root = apiRepo(t);
  put(
    root,
    "src/internal.ts",
    "export interface Zebra { z: string }\nexport interface Alpha { a: number }\n",
  );
  put(
    root,
    "src/index.ts",
    "export type { Zebra, Alpha } from './internal.js';\nexport function greet(name: string): string { return name; }\n",
  );
  put(root, "src/index.test.ts", "testDoesNotTypecheck();\n");
  commit(root);
  execFileSync("git", ["tag", "base"], { cwd: root });
  put(
    root,
    "src/alpha.d.ts",
    "/** Alpha documentation. */\nexport interface Alpha { a: number }\n",
  );
  put(root, "src/internal.ts", "export interface Zebra { z: string }\n");
  put(
    root,
    "src/index.ts",
    "export type { Alpha } from './alpha.js';\nexport type { Zebra } from './internal.js';\n/** A greeting. */\nexport function greet(name: string): string { return name; }\n",
  );
  rmSync(join(root, "src/index.test.ts"));
  commit(root);
  const moved = bin(root, "api-diff", ["base"]);
  assert.equal(moved.status, 0, moved.stdout + moved.stderr);
  assert.match(moved.stdout, /1 packages, 1 entries unchanged.*committed HEAD/);
  put(
    root,
    "src/index.ts",
    "export type { Alpha } from './alpha.js';\nexport type { Zebra } from './internal.js';\nexport function greet(name: number): string { return String(name); }\n",
  );
  assert.equal(bin(root, "api-diff", ["base"]).status, 0);
  commit(root);
  const changed = bin(root, "api-diff", ["base"]);
  assert.equal(changed.status, 1);
  assert.match(changed.stdout, /-.*greet\(name: string\)/);
  assert.match(changed.stdout, /\+.*greet\(name: number\)/);
  const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(worktrees.split("worktree ").length, 2);
});

test("api-diff expands slash-spanning exports, all conditions, main and typesVersions, and rejects a removed entry", (t) => {
  const root = apiRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({
      name: "public-api",
      type: "module",
      exports: {
        "./*": "./dist/features/*.js",
        "./dual": { import: "./dist/esm.mjs", require: "./dist/cjs.cjs" },
      },
      main: "./dist/main.js",
      typings: "./dist/main.d.ts",
      typesVersions: { "*": { compat: ["dist/compat/*.d.ts"] } },
    }),
  );
  for (const path of [
    "features/nested/entry.ts",
    "esm.mts",
    "cjs.cts",
    "main.ts",
    "compat/old.ts",
  ])
    put(root, `src/${path}`, "export interface Value { value: string }\n");
  commit(root);
  const same = bin(root, "api-diff", ["HEAD"]);
  assert.equal(same.status, 0, same.stdout + same.stderr);
  assert.match(same.stdout, /1 packages, 6 entries unchanged/);
  rmSync(join(root, "src/features/nested/entry.ts"));
  commit(root);
  const removed = bin(root, "api-diff", ["HEAD~1"]);
  assert.equal(removed.status, 1);
  assert.match(removed.stdout, /deleted file mode/);
  assert.match(removed.stdout, /exports\/subpath\/nested%2Fentry\.d\.ts/);
});

test("api-diff resolves package-local dependencies, keeps external types external, and ignores private packages", (t) => {
  const root = testRepo(t);
  put(
    root,
    "packages/public/package.json",
    JSON.stringify({
      name: "public-package",
      type: "module",
      types: "./dist/index.d.ts",
      exports: { ".": "./dist/index.js", "./package.json": "./package.json" },
    }),
  );
  put(
    root,
    "packages/public/tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        rootDir: "src",
        outDir: "dist",
        target: "ES2020",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        types: [],
        skipLibCheck: true,
      },
      include: ["src/**/*"],
    }),
  );
  symlinkSync(
    join(PACKAGE_ROOT, "node_modules"),
    join(root, "packages/public/node_modules"),
    "dir",
  );
  put(
    root,
    "packages/public/src/index.ts",
    "import type { Document } from 'yaml';\nexport function inspect(document: Document): boolean { return document.contents !== null; }\n",
  );
  put(root, "packages/private/package.json", '{"private":true}');
  put(root, "packages/private/tsconfig.json", "{}");
  put(root, "packages/private/broken.ts", "unresolvedPrivateType();\n");
  commit(root);
  const same = bin(root, "api-diff", ["HEAD"]);
  assert.equal(same.status, 0, same.stdout + same.stderr);
  assert.match(same.stdout, /1 packages, 2 entries unchanged/);
  put(
    root,
    "packages/public/src/index.ts",
    "import type { Document } from 'yaml';\nexport function inspect(document: Document): number { return document.contents === null ? 0 : 1; }\n",
  );
  commit(root);
  const changed = bin(root, "api-diff", ["HEAD~1"]);
  assert.equal(changed.status, 1, changed.stderr);
  assert.match(changed.stdout, /from ['"]yaml['"]/);
  assert.match(
    changed.stdout,
    /\+.*inspect\(document: Document[^)]*\): number/,
  );
});

test("api-diff fails with compiler diagnostics and removes its worktree on failure; bins require a ref", (t) => {
  const root = apiRepo(t);
  put(root, "src/index.ts", "export const value: number = 'wrong';\n");
  commit(root);
  const result = bin(root, "api-diff", ["HEAD"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not assignable to type 'number'/);
  const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(worktrees.split("worktree ").length, 2);
  for (const name of ["api-diff", "comment-proof"])
    assert.match(bin(root, name).stderr, /Usage: antelopejs-.* <base-ref>/);
});

test("api-diff preserves overload order instead of sorting signatures into a false match", (t) => {
  const root = apiRepo(t);
  put(
    root,
    "src/index.ts",
    "export function pick(value: string): 'text';\nexport function pick(value: unknown): 'other';\nexport function pick(value: unknown): string { return String(value); }\n",
  );
  commit(root);
  put(
    root,
    "src/index.ts",
    "export function pick(value: unknown): 'other';\nexport function pick(value: string): 'text';\nexport function pick(value: unknown): string { return String(value); }\n",
  );
  commit(root);
  const result = bin(root, "api-diff", ["HEAD~1"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /[-+]export declare function pick/);
});

test("api-diff compares published subpaths, allowing entry relocation but catching a removed alias of the same declaration", (t) => {
  const root = apiRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({
      type: "module",
      exports: { "./before": "./dist/index.js" },
    }),
  );
  put(root, "src/index.ts", "export interface Shape { value: string }\n");
  commit(root);
  execFileSync("git", ["tag", "base"], { cwd: root });
  put(
    root,
    "package.json",
    JSON.stringify({
      type: "module",
      exports: { "./after": "./dist/index.js" },
    }),
  );
  commit(root);
  const alias = bin(root, "api-diff", ["base"]);
  assert.equal(alias.status, 1, alias.stderr);
  assert.match(alias.stdout, /deleted file mode/);
  put(
    root,
    "package.json",
    JSON.stringify({
      type: "module",
      exports: { "./before": "./dist/moved.js" },
    }),
  );
  rmSync(join(root, "src/index.ts"));
  put(root, "src/moved.ts", "export interface Shape { value: string }\n");
  commit(root);
  const moved = bin(root, "api-diff", ["base"]);
  assert.equal(moved.status, 0, moved.stdout + moved.stderr);
});
