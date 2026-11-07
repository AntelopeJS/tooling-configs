import assert from "node:assert/strict";
import test from "node:test";

import {
  API_BUILD_SCRIPT,
  apiRepo,
  bin,
  commit,
  put,
} from "./helpers/test-repo.ts";

test("api-diff reports invalid probe JSON and a head-only load failure as execution errors, and skips an unbuilt package", (t) => {
  const root = apiRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({
      scripts: { build: API_BUILD_SCRIPT },
      main: "dist/index.js",
    }),
  );
  put(root, "src/index.ts", "export const value = 1;\n");
  commit(root);
  put(root, "probe.cjs", 'process.stdout.write("not JSON");');
  const invalid = bin(root, "api-diff", ["HEAD", "--probe", "probe.cjs"]);
  assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
  assert.match(invalid.stdout, /Execution error:/);
  assert.doesNotMatch(invalid.stdout, /Behavioural probe ran on both/);
  put(
    root,
    "src/index.ts",
    'throw new Error("only HEAD fails"); export const value = 1;\n',
  );
  commit(root);
  const loadFailure = bin(root, "api-diff", ["HEAD~1"]);
  assert.equal(loadFailure.status, 1, loadFailure.stdout + loadFailure.stderr);
  assert.match(loadFailure.stdout, /Execution error:.*only HEAD fails/s);
  assert.doesNotMatch(loadFailure.stdout, /Runtime API: differences/);
  put(root, "src/index.ts", "export const value = 1;\n");
  put(
    root,
    "package.json",
    JSON.stringify({ scripts: {}, main: "dist/index.js" }),
  );
  commit(root);
  const unbuilt = bin(root, "api-diff", ["HEAD"]);
  assert.equal(unbuilt.status, 0, unbuilt.stdout + unbuilt.stderr);
  assert.match(
    unbuilt.stdout,
    /skipped \., which has no build script and no committed runtime entry/,
  );
});
