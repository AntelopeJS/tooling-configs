import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { parseManifest } from "./package.ts";
import { bin, commit, put, read, testRepo } from "./helpers/test-repo.ts";
import { checkTestTimeouts } from "./test-timeout.ts";

function withScripts(
  root: string,
  scripts: Record<string, string>,
  path = "package.json",
): void {
  const manifest = parseManifest(
    path === "package.json" ? read(root, path) : '{ "name": "member" }',
  );
  manifest.scripts = { ...manifest.scripts, ...scripts };
  put(root, path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function errorsFor(t: TestContext, scripts: Record<string, string>): string[] {
  const root = testRepo(t);
  withScripts(root, scripts);
  return checkTestTimeouts(root, true).errors;
}

test("the hand-set limits of dms-database, rethinkdb and cloud's default each fail, naming the script, the limit and the fix; a check that reads only the test script passes cloud's integration run", (t) => {
  const errors = errorsFor(t, {
    test: '([ -n "$DMS_PREBUILT" ] || pnpm run build) && DMS_PREBUILT=1 ajs module test . --timeout 30000 && ajs module test . --timeout 10000',
    "test:integration": "pnpm run build && ajs module test .",
    "test:infra": "mocha scripts/test-infra.cjs",
  });
  assert.deepEqual(errors, [
    'package.json script "test" runs ajs module test with its own --timeout 10000; set --timeout 30000, the shared CI test timeout.',
    `package.json script "test:integration" runs ajs module test on mocha's 2000 ms default timeout; add --timeout 30000, the shared CI test timeout.`,
    `package.json script "test:infra" runs mocha on mocha's 2000 ms default timeout; add --timeout 30000, the shared CI test timeout.`,
  ]);
});

test("every spelling of the shared timeout passes, through pnpm exec, npx and a path to mocha; a check that accepts only `--timeout <ms>` reports them", (t) => {
  assert.deepEqual(
    errorsFor(t, {
      a: "ajs module test . --timeout=30000",
      b: "pnpm exec ajs module test . -f dist/a.test.js --timeout 30000",
      c: "npx mocha -t 30000 'dist/**/*.test.js'",
      d: "node_modules/.bin/mocha --timeout=30000",
      e: "pnpm run build && node --test && vitest run",
    }),
    [],
  );
});

test("a workspace member's hand-set limit fails under its own path, as dms-media's does; a check that reads only the root manifest passes it", (t) => {
  const root = testRepo(t);
  put(root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  withScripts(
    root,
    {
      "test:unit":
        '[ -n "$DMS_PREBUILT" ] || pnpm run build && DMS_MEDIA_TEST_DIR=dist/test/unit ajs module test . --timeout 10000',
    },
    "packages/dms-media/package.json",
  );
  assert.deepEqual(checkTestTimeouts(root, true).errors, [
    'packages/dms-media/package.json script "test:unit" runs ajs module test with its own --timeout 10000; set --timeout 30000, the shared CI test timeout.',
  ]);
});

test("sync --check fails on a hand-set limit and a write run prints it as a Note and exits 0; a sync that never runs the check passes the repository, and one that fails the write run blocks it from syncing", (t) => {
  const root = testRepo(t);
  assert.equal(bin(root, "sync").status, 0);
  withScripts(root, { test: "ajs module test . --timeout 10000" });
  commit(root);
  const finding =
    /^package\.json script "test" runs ajs module test with its own --timeout 10000/m;

  const check = bin(root, "sync", ["--check"]);
  assert.equal(check.status, 1, check.stdout);
  assert.match(check.stderr, finding);

  const write = bin(root, "sync");
  assert.equal(write.status, 0, write.stderr);
  assert.match(
    write.stdout,
    new RegExp(`^Note: ${finding.source.slice(1)}`, "m"),
  );
});
