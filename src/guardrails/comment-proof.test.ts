import assert from "node:assert/strict";
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

test("comment-proof strips comments, ignores type errors and test deletions, includes private packages, and detects changed or missing JS", (t) => {
  const root = testRepo(t);
  symlinkSync(
    join(PACKAGE_ROOT, "node_modules"),
    join(root, "node_modules"),
    "dir",
  );
  put(root, "package.json", JSON.stringify({ private: true, type: "module" }));
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
        noEmit: true,
        noEmitOnError: true,
        declaration: true,
        sourceMap: true,
      },
      include: ["src/**/*.ts"],
    }),
  );
  put(
    root,
    "src/index.ts",
    "// oxlint-disable-next-line rule -- reason\n// SAFETY: old boundary\n// @ts-expect-error fixture\nexport const value: number = 'type error';\n",
  );
  put(root, "src/index.test.ts", "export const changedTest = 1;\n");
  put(root, "src/spare.ts", "export const spare = 5;\n");
  put(
    root,
    "output/tool.cjs",
    "// SAFETY: generated output, left out like the size guard leaves it out\n",
  );
  commit(root);
  put(
    root,
    "src/index.ts",
    "// eslint-disable-next-line rule -- reason\n// oxlint-disable rule -- reason\n// SAFETY: new boundary\n// SAFETY: second boundary\nexport const value: number = 'type error';\n",
  );
  rmSync(join(root, "src/index.test.ts"));
  commit(root);
  const comments = bin(root, "comment-proof", ["HEAD~1"]);
  assert.equal(comments.status, 0, comments.stdout + comments.stderr);
  assert.match(
    comments.stdout,
    /1 packages, 2 entries unchanged.*committed HEAD/,
  );
  assert.match(
    comments.stdout,
    /\| Lint suppressions, all rules \| 1 \| 2 \|\n\| Lint suppressions, `rule` \| 1 \| 2 \|/,
  );
  assert.match(comments.stdout, /\| `SAFETY:` comments \| 1 \| 2 \|/);
  assert.match(comments.stdout, /\| `@ts-expect-error` \| 1 \| 0 \|/);
  put(root, "src/index.ts", "export const value: number = 'runtime change';\n");
  assert.equal(bin(root, "comment-proof", ["HEAD~1"]).status, 0);
  commit(root);
  const code = bin(root, "comment-proof", ["HEAD~1"]);
  assert.equal(code.status, 1);
  assert.match(code.stdout, /-export const value = 'type error'/);
  assert.match(code.stdout, /\+export const value = 'runtime change'/);
  assert.match(code.stdout, /\| `SAFETY:` comments \| 2 \| 0 \|/);
  rmSync(join(root, "src/spare.ts"));
  commit(root);
  const missing = bin(root, "comment-proof", ["HEAD~1"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /deleted file mode/);
  assert.match(missing.stdout, /spare\.js/);
});

test("comment-proof emits a package whose TypeScript has no compiler API with the pack's TypeScript", (t) => {
  const root = testRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({
      private: true,
      type: "module",
      devDependencies: { typescript: "7.0.2" },
    }),
  );
  put(
    root,
    "node_modules/typescript/package.json",
    JSON.stringify({ name: "typescript", version: "7.0.2", main: "index.js" }),
  );
  put(
    root,
    "node_modules/typescript/index.js",
    'module.exports = { version: "7.0.2" };\n',
  );
  put(
    root,
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { module: "NodeNext", rootDir: "src", types: [] },
      include: ["src/**/*.ts"],
    }),
  );
  put(root, "src/index.ts", "// old\nexport const value = 1;\n");
  commit(root);
  put(root, "src/index.ts", "// new\nexport const value = 1;\n");
  commit(root);
  const result = bin(root, "comment-proof", ["HEAD~1"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1 packages, 1 entries unchanged/);
});

test("comment-proof compiles workspace packages under a private root tsconfig that lists no files", (t) => {
  const root = testRepo(t);
  symlinkSync(
    join(PACKAGE_ROOT, "node_modules"),
    join(root, "node_modules"),
    "dir",
  );
  put(root, "package.json", JSON.stringify({ private: true, type: "module" }));
  put(
    root,
    "tsconfig.json",
    JSON.stringify({
      files: [],
      compilerOptions: {
        target: "ES2020",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        types: [],
      },
    }),
  );
  put(
    root,
    "packages/lib/package.json",
    JSON.stringify({ name: "lib", type: "module", main: "dist/index.js" }),
  );
  put(
    root,
    "packages/lib/tsconfig.json",
    JSON.stringify({
      extends: "../../tsconfig.json",
      compilerOptions: { rootDir: "src", outDir: "dist" },
      include: ["src/**/*.ts"],
    }),
  );
  put(root, "packages/lib/src/index.ts", "export const value = 1;\n");
  commit(root);
  put(
    root,
    "packages/lib/src/index.ts",
    "/** The value. */\nexport const value = 1;\n",
  );
  commit(root);
  const unchanged = bin(root, "comment-proof", ["HEAD~1"]);
  assert.equal(unchanged.status, 0, unchanged.stdout + unchanged.stderr);
  assert.match(unchanged.stdout, /1 packages, 1 entries unchanged/);
  put(root, "packages/lib/src/index.ts", "export const value = 2;\n");
  commit(root);
  const changed = bin(root, "comment-proof", ["HEAD~1"]);
  assert.equal(changed.status, 1, changed.stdout + changed.stderr);
  assert.match(changed.stdout, /\+export const value = 2/);
});

test("comment-proof fails on a root tsconfig that lists no files unless it parses to no inputs and a package extends it", (t) => {
  const root = testRepo(t);
  symlinkSync(
    join(PACKAGE_ROOT, "node_modules"),
    join(root, "node_modules"),
    "dir",
  );
  put(root, "package.json", JSON.stringify({ private: true, type: "module" }));
  put(root, "tsconfig.json", JSON.stringify({ files: [] }));
  put(
    root,
    "tsconfig.build.json",
    JSON.stringify({ compilerOptions: { types: [] }, include: ["src"] }),
  );
  put(root, "src/index.ts", "export const value = 1;\n");
  commit(root);
  put(root, "src/index.ts", "export const value = 2;\n");
  commit(root);
  const alone = bin(root, "comment-proof", ["HEAD~1"]);
  assert.equal(alone.status, 1, alone.stdout);
  assert.match(alone.stderr, /TS18002/);
  put(
    root,
    "packages/lib/package.json",
    JSON.stringify({ name: "lib", private: true, type: "module" }),
  );
  put(
    root,
    "packages/lib/tsconfig.json",
    JSON.stringify({ compilerOptions: { types: [] }, include: ["src"] }),
  );
  put(root, "packages/lib/src/index.ts", "export const lib = 1;\n");
  commit(root);
  const unextended = bin(root, "comment-proof", ["HEAD~1"]);
  assert.equal(unextended.status, 1, unextended.stdout);
  assert.match(unextended.stderr, /TS18002/);
  put(
    root,
    "tsconfig.json",
    JSON.stringify({
      files: [],
      include: ["src"],
      compilerOptions: { types: [] },
    }),
  );
  put(
    root,
    "packages/lib/tsconfig.json",
    JSON.stringify({ extends: "../../tsconfig.json", include: ["src"] }),
  );
  commit(root);
  const included = bin(root, "comment-proof", ["HEAD~1"]);
  assert.equal(included.status, 1, included.stdout);
  assert.match(included.stderr, /TS18002/);
});

test("comment-proof skips and reports a package whose tsconfig extends a repository file the commit does not hold, still proves the rest, and fails on a missing base outside the repository", (t) => {
  const root = testRepo(t);
  symlinkSync(
    join(PACKAGE_ROOT, "node_modules"),
    join(root, "node_modules"),
    "dir",
  );
  put(root, ".gitignore", "node_modules\n*.generated.json\n");
  put(root, "package.json", JSON.stringify({ private: true, type: "module" }));
  put(
    root,
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        rootDir: "src",
        outDir: "dist",
        types: [],
      },
      include: ["src/**/*.ts"],
    }),
  );
  put(root, "src/index.ts", "export const value = 1;\n");
  put(root, "templates/vue/package.json", JSON.stringify({ private: true }));
  put(
    root,
    "templates/vue/tsconfig.json",
    JSON.stringify({
      extends: "./frontend-paths.generated.json",
      include: ["*.ts"],
    }),
  );
  put(root, "templates/vue/frontend-paths.generated.json", "{}");
  put(root, "templates/vue/app.ts", "export const app = 1;\n");
  commit(root);
  put(root, "src/index.ts", "/** The value. */\nexport const value = 1;\n");
  commit(root);
  const proof = bin(root, "comment-proof", ["HEAD~1"]);
  assert.equal(proof.status, 0, proof.stdout + proof.stderr);
  assert.match(proof.stdout, /1 packages, 1 entries unchanged/);
  assert.match(
    proof.stdout,
    /Comment proof: skipped templates\/vue, its tsconfig extends templates\/vue\/frontend-paths\.generated\.json, which the commit does not hold\.\n/,
  );
  put(root, "src/index.ts", "export const value = 2;\n");
  commit(root);
  const changed = bin(root, "comment-proof", ["HEAD~1"]);
  assert.equal(changed.status, 1);
  assert.match(changed.stdout, /\+export const value = 2;/);
  put(
    root,
    "templates/outside/package.json",
    JSON.stringify({ private: true }),
  );
  put(
    root,
    "templates/outside/tsconfig.json",
    JSON.stringify({ extends: join(root, "..", "absent-base.json") }),
  );
  commit(root);
  const outside = bin(root, "comment-proof", ["HEAD~1"]);
  assert.equal(outside.status, 1);
  assert.match(outside.stdout + outside.stderr, /TS5083.*absent-base\.json/);
});
