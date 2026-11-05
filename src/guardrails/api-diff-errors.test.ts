import assert from "node:assert/strict";
import test from "node:test";

import { apiRepo, bin, commit, put } from "./helpers/test-repo.ts";

test("api-diff reports missing artifacts, load failures, timeouts and invalid probe JSON as execution errors", (t) => {
  const root = apiRepo(t);
  put(root, "src/index.ts", "export const value = 1;\n");
  const cases = [
    {
      scripts: { build: 'node -e "process.exit(0)"' },
      main: "dist/missing.js",
      message: /missing built runtime entry/,
    },
    {
      scripts: {
        build: "tsc --noEmit false --composite false --declarationMap false",
      },
      main: "dist/index.js",
      message: /load failed/,
    },
    {
      scripts: {
        build: "tsc --noEmit false --composite false --declarationMap false",
      },
      main: "dist/index.js",
      message: /ETIMEDOUT/,
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
    if (index === 2)
      put(root, "src/index.ts", "while (true) {} export const value = 1;\n");
    commit(root);
    const result = bin(root, "api-diff", ["HEAD"]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /Execution error:/);
    assert.match(result.stdout, fixture.message);
    assert.doesNotMatch(result.stdout, /Runtime API: differences/);
  }
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
