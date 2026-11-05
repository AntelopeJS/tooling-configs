import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  apiRepo,
  bin,
  commit,
  PACKAGE_ROOT,
  put,
  testRepo,
} from "./helpers/test-repo.ts";

test("api-diff ignores internal moves out of a nested test folder, declaration order and TSDoc, but detects an exported signature change in committed HEAD", (t) => {
  const root = apiRepo(t);
  put(
    root,
    "src/core/test/internal.ts",
    "export interface Zebra { z: string }\nexport interface Alpha { a: number }\n",
  );
  put(
    root,
    "src/index.ts",
    "export type { Zebra, Alpha } from './core/test/internal.js';\nexport function greet(name: string): string { return name; }\n",
  );
  put(root, "src/index.test.ts", "testDoesNotTypecheck();\n");
  commit(root);
  execFileSync("git", ["tag", "base"], { cwd: root });
  put(
    root,
    "src/alpha.d.ts",
    "/** Alpha documentation. */\nexport interface Alpha { a: number }\n",
  );
  rmSync(join(root, "src/core"), { recursive: true });
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

test("api-diff resolves package-local dependencies, keeps external types external, and ignores private packages", (t) => {
  const root = testRepo(t);
  put(
    root,
    "packages/public/package.json",
    JSON.stringify({
      name: "public-package",
      type: "module",
      scripts: { build: "tsc" },
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
  assert.match(
    result.stdout,
    /Execution error:.*|not assignable to type 'number'/,
  );
  assert.match(result.stdout, /not assignable to type 'number'/);
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
