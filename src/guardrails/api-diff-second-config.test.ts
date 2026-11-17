import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  API_BUILD_SCRIPT,
  apiRepo,
  bin,
  commit,
  put,
} from "./helpers/test-repo.ts";

const E2E = "bin/control/e2e.mjs";

function e2eSource(type: string): string {
  return `/**\n * @param {${type}} name\n * @returns {${type}}\n */\nexport function journey(name) {\n  return name;\n}\nexport const STEPS = ["open"];\nexport class Journey {\n  /** @type {${type}} */\n  name;\n}\n`;
}

/** The `@antelopejs/dms` layout: `tsconfig.json` emits `src` into `dist`, and `bin/tsconfig.types.json`, which only the build script names, emits the declarations of an authored `.mjs` entry into `dist/bin`. */
function secondConfigRepo(t: TestContext): string {
  const root = apiRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({
      name: "public-api",
      type: "module",
      scripts: {
        build: `${API_BUILD_SCRIPT} && tsc -p bin/tsconfig.types.json`,
      },
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./e2e": {
          types: "./dist/bin/control/e2e.d.mts",
          default: `./${E2E}`,
        },
      },
    }),
  );
  put(
    root,
    "bin/tsconfig.json",
    JSON.stringify({
      extends: "../tsconfig.json",
      compilerOptions: {
        noEmit: true,
        allowJs: true,
        composite: false,
        declaration: false,
        rootDir: ".",
      },
      include: ["**/*.mjs"],
    }),
  );
  put(
    root,
    "bin/tsconfig.types.json",
    JSON.stringify({
      extends: "./tsconfig.json",
      compilerOptions: {
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        outDir: "../dist/bin",
      },
      include: [],
      files: ["control/e2e.mjs"],
    }),
  );
  put(root, "src/index.ts", "export const value: number = 1;\n");
  put(root, E2E, e2eSource("string"));
  return root;
}

test("api-diff compares a published declaration that a second tsconfig of the package emits", (t) => {
  const root = secondConfigRepo(t);
  commit(root);
  const same = bin(root, "api-diff", ["HEAD"]);
  assert.equal(same.status, 0, same.stdout + same.stderr);
  assert.match(same.stdout, /^API: 1 packages, 2 entries unchanged/mu);

  put(root, E2E, e2eSource("number"));
  commit(root);
  const changed = bin(root, "api-diff", ["HEAD~1"]);
  assert.equal(changed.status, 1, changed.stdout + changed.stderr);
  assert.doesNotMatch(changed.stdout, /Execution error/u);
  assert.match(
    changed.stdout,
    /^\+export declare function journey\(name: number\): number;/mu,
  );
});

test("api-diff leaves out a tsconfig of the package that does not parse or publishes no target", (t) => {
  const root = secondConfigRepo(t);
  put(root, "fixtures/tsconfig.json", "{ not json");
  put(
    root,
    "tsconfig.other.json",
    JSON.stringify({
      extends: "./tsconfig.json",
      compilerOptions: {
        rootDir: "other",
        outDir: "dist/other",
        noEmit: false,
        declaration: true,
      },
      include: ["other"],
    }),
  );
  put(root, "other/broken.ts", 'export const broken: number = "1";\n');
  commit(root);
  const result = bin(root, "api-diff", ["HEAD"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^API: 1 packages, 2 entries unchanged/mu);
});

test("api-diff compares a declaration that both tsconfigs emit once", (t) => {
  const root = secondConfigRepo(t);
  put(
    root,
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2020",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        rootDir: ".",
        outDir: "dist",
        types: [],
        strict: true,
        noEmit: true,
        allowJs: true,
      },
      include: ["src/**/*", E2E],
    }),
  );
  put(
    root,
    "package.json",
    JSON.stringify({
      name: "public-api",
      type: "module",
      exports: {
        ".": { types: "./dist/src/index.d.ts", default: "./dist/index.js" },
        "./e2e": {
          types: "./dist/bin/control/e2e.d.mts",
          default: `./${E2E}`,
        },
      },
    }),
  );
  commit(root);
  const result = bin(root, "api-diff", ["HEAD"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^API: 1 packages, 2 entries unchanged/mu);
});
