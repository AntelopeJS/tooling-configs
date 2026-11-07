import assert from "node:assert/strict";
import test from "node:test";

import {
  API_BUILD_SCRIPT,
  apiRepo,
  bin,
  commit,
  put,
} from "./helpers/test-repo.ts";

test("api-diff reports a probe timeout as an execution error", (t) => {
  const root = apiRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({
      scripts: { build: API_BUILD_SCRIPT },
      main: "dist/index.js",
    }),
  );
  put(root, "src/index.ts", "while (true) {} export const value = 1;\n");
  commit(root);
  const result = bin(root, "api-diff", ["HEAD"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Execution error:/);
  assert.match(result.stdout, /ETIMEDOUT/);
  assert.doesNotMatch(result.stdout, /Runtime API: differences/);
});
