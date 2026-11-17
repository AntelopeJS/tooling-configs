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
  return `/**\n * @param {${type}} name\n * @returns {${type}}\n */\nexport function journey(name) {\n  return name;\n}\n`;
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
