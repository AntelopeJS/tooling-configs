import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { apiRepo, bin, commit, put } from "./helpers/test-repo.ts";

const SCRIPT = [
  'import { realpathSync } from "node:fs";',
  'import { fileURLToPath } from "node:url";',
  "export function check(roots) { return roots.length; }",
  "if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)))",
  '  throw new Error("ran as a command");',
  "",
].join("\n");

function scriptRepo(t: TestContext): string {
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
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./checks/script": "./scripts/check.mjs",
      },
    }),
  );
  put(root, "src/index.ts", "export const value = 1;\n");
  put(root, "scripts/check.mjs", SCRIPT);
  put(
    root,
    "scripts/check.d.mts",
    "export declare function check(roots: string[]): number;\n",
  );
  commit(root);
  return root;
}

test("api-diff measures a published script outside the build output through its authored declaration, without running it as a command", (t) => {
  const root = scriptRepo(t);
  const result = bin(root, "api-diff", ["HEAD"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^API: 1 packages, 2 entries unchanged/m);
  assert.match(result.stdout, /Runtime API: 1 packages, 2 entries unchanged/);
  assert.doesNotMatch(result.stdout + result.stderr, /Execution error/);
});

test("api-diff reports a signature change in the authored declaration of a published script", (t) => {
  const root = scriptRepo(t);
  put(
    root,
    "scripts/check.d.mts",
    "export declare function check(roots: string[], strict: boolean): number;\n",
  );
  commit(root);
  const result = bin(root, "api-diff", ["HEAD~1"]);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /strict: boolean/);
  assert.doesNotMatch(result.stdout + result.stderr, /Execution error/);
});
