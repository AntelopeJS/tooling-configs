import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { ExportTarget } from "./typescript.ts";
import { apiRepo, bin, commit, put } from "./helpers/test-repo.ts";

const ROOT_ENTRY = { types: "./dist/index.d.ts", default: "./dist/index.js" };

const HELPER =
  "declare const describe: (name: string, body: () => void) => void;\nexport const helper = 1;\ndescribe('needs a runner', () => {});\n";

function helperRepo(t: TestContext, exports: Record<string, ExportTarget>) {
  const root = apiRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({
      name: "public-api",
      type: "module",
      scripts: {
        build: "tsc --noEmit false --composite false --declarationMap false",
      },
      exports: { ".": ROOT_ENTRY, ...exports },
    }),
  );
  put(root, "src/index.ts", "export const value = 1;\n");
  put(root, "src/tests/helper.ts", HELPER);
  commit(root);
  return root;
}

test("api-diff runs the runtime half on a package whose only wildcard export is ./tests/*, and says it skipped the helpers", (t) => {
  const root = helperRepo(t, {
    "./tests/*": {
      types: "./dist/tests/*.d.ts",
      default: "./dist/tests/*.js",
    },
  });
  const result = bin(root, "api-diff", ["HEAD"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^API: 1 packages, 1 entries unchanged/);
  assert.match(result.stdout, /Runtime API: 1 packages, 1 entries unchanged/);
  assert.match(
    result.stdout,
    /^API: skipped test-helper entry \.\/dist\/tests\/\*\.d\.ts in \./m,
  );
  assert.match(
    result.stdout,
    /^Runtime API: skipped test-helper entry \.\/dist\/tests\/\*\.js in \./m,
  );
  assert.doesNotMatch(result.stdout, /Execution error/);
});

test("api-diff treats ./tests/* entries the same in both halves when a general wildcard also publishes them", (t) => {
  const root = helperRepo(t, {
    "./*": { types: "./dist/*.d.ts", default: "./dist/*.js" },
  });
  put(root, "src/tests/helper.ts", `${HELPER}export const added = 2;\n`);
  commit(root);
  const result = bin(root, "api-diff", ["HEAD~1"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^API: 1 packages, 2 entries unchanged/);
  assert.match(result.stdout, /Runtime API: 1 packages, 2 entries unchanged/);
  assert.match(
    result.stdout,
    /^API: skipped test-helper entry \.\/dist\/\*\.d\.ts in \./m,
  );
  assert.match(
    result.stdout,
    /^Runtime API: skipped test-helper entry \.\/dist\/\*\.js in \./m,
  );
});

test("api-diff skips a plain published test-helper entry in both halves", (t) => {
  const root = helperRepo(t, {
    "./tests/helper": {
      types: "./dist/tests/helper.d.ts",
      default: "./dist/tests/helper.js",
    },
  });
  const result = bin(root, "api-diff", ["HEAD"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^API: 1 packages, 1 entries unchanged/);
  assert.match(result.stdout, /Runtime API: 1 packages, 1 entries unchanged/);
  assert.match(
    result.stdout,
    /Runtime API: skipped test-helper entry \.\/dist\/tests\/helper\.js/,
  );
});
