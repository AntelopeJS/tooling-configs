import assert from "node:assert/strict";
import test from "node:test";

import { bin, put, testRepo } from "./helpers/test-repo.ts";

test("checks suppresses passing output, reports missing scripts, and continues after failures", (t) => {
  const root = testRepo(t);
  put(root, "guardrails.ratchet.json", '{"rules":{},"oversizeFiles":{}}');
  const scripts = {
    typecheck: "node -e \"console.log('hidden success')\"",
    lint: "node -e \"console.error('lint broke');process.exit(2)\"",
    "format:check": "node -e \"console.log('hidden success')\"",
    knip: "node -e \"console.log('hidden success')\"",
    test: "node -e \"console.log('hidden success')\"",
    ratchet: "node -e \"console.error('later failure');process.exit(1)\"",
    "sync:check": "node -e \"console.log('hidden success')\"",
  };
  put(
    root,
    "package.json",
    JSON.stringify({ packageManager: "npm@11.0.0", scripts }),
  );
  const result = bin(root, "checks");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /lint broke/);
  assert.match(result.stdout, /Missing package.json script "size"/);
  assert.match(result.stdout, /later failure/);
  assert.doesNotMatch(result.stdout, /hidden success/);
  assert.match(result.stdout, /Missing package.json script "suppressions"/);
  assert.match(result.stdout, /Checks: 5 passed, 4 failed\./);
  put(
    root,
    "package.json",
    JSON.stringify({
      packageManager: "npm@11.0.0",
      scripts: Object.fromEntries(
        [
          "typecheck",
          "lint",
          "format:check",
          "knip",
          "test",
          "size",
          "ratchet",
          "suppressions",
          "sync:check",
        ].map((name) => [name, "node -e \"console.log('hidden success')\""]),
      ),
    }),
  );
  const passing = bin(root, "checks");
  assert.equal(passing.status, 0);
  assert.equal(passing.stdout, "Checks: 9 passed, 0 failed.\n");
});

test("checks skips ratchet by file absence even if a stale ratchet script fails", (t) => {
  const root = testRepo(t);
  const scripts = Object.fromEntries(
    [
      "typecheck",
      "lint",
      "format:check",
      "knip",
      "test",
      "size",
      "suppressions",
      "sync:check",
    ].map((name) => [name, 'node -e "process.exit(0)"']),
  );
  scripts.ratchet = 'node -e "process.exit(1)"';
  put(root, "package.json", JSON.stringify({ packageManager: "npm", scripts }));
  const result = bin(root, "checks");
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "Checks: 8 passed, 0 failed.\n");
});
