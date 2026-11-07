import assert from "node:assert/strict";
import test from "node:test";

import {
  API_BUILD_SCRIPT,
  apiRepo,
  bin,
  commit,
  put,
} from "./helpers/test-repo.ts";

test("api-diff reports missing artifacts and load failures as execution errors", (t) => {
  const root = apiRepo(t);
  put(root, "src/index.ts", "export const value = 1;\n");
  const cases = [
    {
      scripts: { build: 'node -e "process.exit(0)"' },
      main: "dist/missing.js",
      message: /missing built runtime entry/,
    },
    {
      scripts: { build: API_BUILD_SCRIPT },
      main: "dist/index.js",
      message: /load failed/,
    },
  ];
  for (const [index, fixture] of cases.entries()) {
    put(root, "package.json", JSON.stringify(fixture));
    if (index === 1)
      put(
        root,
        "src/index.ts",
        'throw new Error("load failed"); export const value = 1;\n',
      );
    commit(root);
    const result = bin(root, "api-diff", ["HEAD"]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /Execution error:/);
    assert.match(result.stdout, fixture.message);
    assert.doesNotMatch(result.stdout, /Runtime API: differences/);
  }
});
