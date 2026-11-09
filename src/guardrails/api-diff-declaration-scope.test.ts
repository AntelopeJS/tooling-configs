import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { apiRepo, bin, commit, put } from "./helpers/test-repo.ts";

const NON_PORTABLE =
  'import type { KnipConfig } from "knip";\ndeclare const config: KnipConfig;\nexport default { ...config, ignore: ["a"] };\n';

function layout(
  t: TestContext,
  compilerOptions: { outDir: string; rootDir?: string },
  tsconfig: { include: string[] } | { files: string[] },
  exports: Record<string, string>,
): string {
  const root = apiRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({
      name: "public-api",
      type: "module",
      exports: Object.fromEntries(
        Object.entries(exports).map(([subpath, types]) => [
          subpath,
          { types, default: "./dist/index.js" },
        ]),
      ),
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
        types: [],
        strict: true,
        noEmit: true,
        ...compilerOptions,
      },
      ...tsconfig,
    }),
  );
  return root;
}

function declarationFailure(root: string): string {
  commit(root);
  const result = bin(root, "api-diff", ["HEAD"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  return result.stdout;
}

test("api-diff ignores a non-portable inferred type in a module no published entry reaches, and still fails one a published entry exports (#74)", (t) => {
  const root = apiRepo(t);
  put(root, "src/index.ts", "export const value: number = 1;\n");
  put(root, "src/knip.config.ts", NON_PORTABLE);
  commit(root);
  const unpublished = bin(root, "api-diff", ["HEAD"]);
  assert.equal(unpublished.status, 0, unpublished.stdout + unpublished.stderr);
  assert.doesNotMatch(unpublished.stdout, /TS2742/);

  put(root, "src/index.ts", NON_PORTABLE);
  assert.match(declarationFailure(root), /index\.ts.*TS2742/);
});

test("api-diff names the declaration error of a published module whose emit sits under a common root wider than its include", (t) => {
  const root = layout(
    t,
    { outDir: "dist" },
    { include: ["src"] },
    { ".": "./dist/src/index.d.ts" },
  );
  put(root, "lib/util.ts", "export const util = 1;\n");
  put(root, "src/index.ts", `import "../lib/util.js";\n${NON_PORTABLE}`);
  assert.match(declarationFailure(root), /src\/index\.ts.*TS2742/);
});

test("api-diff names the declaration error of a published module that is no tsconfig root", (t) => {
  const root = layout(
    t,
    { rootDir: "src", outDir: "dist" },
    { files: ["src/index.ts"] },
    { ".": "./dist/index.d.ts", "./helper": "./dist/helper.d.ts" },
  );
  put(root, "src/index.ts", 'export { default } from "./helper.js";\n');
  put(root, "src/helper.ts", NON_PORTABLE);
  assert.match(declarationFailure(root), /helper\.ts.*TS2742/);
});

test("api-diff names the declaration error of a module an authored published declaration re-exports", (t) => {
  const root = layout(
    t,
    { rootDir: "src", outDir: "dist" },
    { include: ["src"] },
    { ".": "./dist/public.d.ts" },
  );
  put(root, "src/public.d.ts", 'export * from "./impl.js";\n');
  put(root, "src/impl.ts", NON_PORTABLE);
  assert.match(declarationFailure(root), /impl\.ts.*TS2742/);
});

test("api-diff reports a published target it cannot match without the declaration error of a module that target does not name", (t) => {
  const root = layout(
    t,
    { rootDir: "src", outDir: "dist" },
    { include: ["src"] },
    { ".": "./dist/index.d.ts", "./bundled": "./dist/bundled.d.mts" },
  );
  put(root, "src/index.ts", "export const value: number = 1;\n");
  put(root, "src/knip.config.ts", NON_PORTABLE);
  const output = declarationFailure(root);
  assert.match(output, /bundled\.d\.mts has no emitted declaration/);
  assert.doesNotMatch(output, /TS2742/);
});

test("api-diff names the declaration error of a module a wildcard export publishes", (t) => {
  const root = layout(
    t,
    { rootDir: "src", outDir: "dist" },
    { include: ["src"] },
    { "./*": "./dist/*.d.ts" },
  );
  put(root, "src/a.ts", "export const a: number = 1;\n");
  put(root, "src/b.ts", NON_PORTABLE);
  assert.match(declarationFailure(root), /b\.ts.*TS2742/);
});

test("api-diff names the declaration error of a published module whose emit root widens to a source outside its package", (t) => {
  const root = apiRepo(t);
  put(root, "package.json", JSON.stringify({ name: "root", private: true }));
  put(root, "shared/x.ts", "export const x = 1;\n");
  put(
    root,
    "packages/public/package.json",
    JSON.stringify({
      name: "public-package",
      type: "module",
      exports: {
        ".": {
          types: "./dist/packages/public/src/index.d.ts",
          default: "./dist/index.js",
        },
      },
    }),
  );
  put(
    root,
    "packages/public/tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2020",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        types: [],
        strict: true,
        noEmit: true,
        outDir: "dist",
      },
      include: ["src"],
    }),
  );
  put(
    root,
    "packages/public/src/index.ts",
    `import "../../../shared/x.js";\n${NON_PORTABLE}`,
  );
  assert.match(declarationFailure(root), /src\/index\.ts.*TS2742/);
});

test("api-diff names the declaration error of a published module whose emit root widens to a test helper it imports", (t) => {
  const root = layout(
    t,
    { outDir: "dist" },
    { include: ["src"] },
    { ".": "./dist/src/index.d.ts" },
  );
  put(root, "test/fixtures.ts", "export const fixture = 1;\n");
  put(root, "src/index.ts", `import "../test/fixtures.js";\n${NON_PORTABLE}`);
  assert.match(declarationFailure(root), /src\/index\.ts.*TS2742/);
});
