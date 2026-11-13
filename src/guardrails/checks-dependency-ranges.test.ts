import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { bin, commit, put, testRepo } from "./helpers/test-repo.ts";

const PASSING_STEPS = [
  "typecheck",
  "lint",
  "format:check",
  "knip",
  "test",
  "size",
  "suppressions",
  "sync:check",
];

/** A committed repository whose every script step passes and whose playground declares `range` on an interface, so only that range decides the run. */
function repoWithRange(t: TestContext, range: string): string {
  const root = testRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({
      packageManager: "pnpm@10.2.0",
      scripts: Object.fromEntries(
        PASSING_STEPS.map((name) => [name, 'node -e "process.exit(0)"']),
      ),
    }),
  );
  put(
    root,
    "playground/package.json",
    JSON.stringify({
      dependencies: { "@antelopejs/interface-database": range },
    }),
  );
  commit(root);
  return root;
}

test("an open 0.x range in a nested manifest fails checks with its fix, where a run without the dependency:ranges step passes the range that resolves a breaking minor", (t) => {
  const result = bin(repoWithRange(t, ">=0.3.0 <1.0.0"), "checks");
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /\[dependency:ranges\]\nplayground\/package\.json: dependencies\["@antelopejs\/interface-database"\] is ">=0\.3\.0 <1\.0\.0": .*; use ">=0\.3\.0 <0\.4\.0"\n/,
  );
  assert.match(result.stdout, /Checks: 9 passed, 1 failed\./);
});

test("a range capped below the next minor passes checks, where a step that reports every AntelopeJS range fails a repository that already complies", (t) => {
  const result = bin(repoWithRange(t, ">=0.3.0 <0.4.0"), "checks");
  assert.equal(result.status, 0, result.stdout);
});
