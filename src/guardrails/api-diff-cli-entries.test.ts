import assert from "node:assert/strict";
import test from "node:test";

import { apiRepo, bin, commit, put } from "./helpers/test-repo.ts";

test("api-diff describes the other wildcard entries when one prints on import and another exits, and compares the exit code", (t) => {
  const root = apiRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({
      name: "cli-api",
      type: "module",
      scripts: {
        build: "tsc --noEmit false --composite false --declarationMap false",
      },
      exports: { "./dist/*.js": "./dist/*.js" },
    }),
  );
  put(
    root,
    "src/index.ts",
    'console.log("cli 0.1.0 usage");\nexport const version = "0.1.0";\n',
  );
  put(
    root,
    "src/runner.ts",
    'declare const process: { exit(code: number): never };\nconsole.log("runner needs a file");\nprocess.exit(2);\n',
  );
  put(root, "src/lib.ts", "export function run(file: string) {}\n");
  commit(root);
  const unchanged = bin(root, "api-diff", ["HEAD"]);
  assert.equal(unchanged.status, 0, unchanged.stdout + unchanged.stderr);
  assert.doesNotMatch(unchanged.stdout, /Execution error/);
  assert.match(
    unchanged.stdout,
    /Runtime API: 1 packages, 3 entries unchanged/,
  );
  put(
    root,
    "src/runner.ts",
    'declare const process: { exit(code: number): never };\nconsole.log("runner needs a file");\nprocess.exit(3);\n',
  );
  commit(root);
  const changed = bin(root, "api-diff", ["HEAD~1"]);
  assert.equal(changed.status, 1, changed.stdout + changed.stderr);
  assert.match(changed.stdout, /Runtime API: differences/);
  assert.match(changed.stdout, /-  "exit": 2\n\+  "exit": 3\n/);
});
