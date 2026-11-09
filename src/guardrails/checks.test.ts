import assert from "node:assert/strict";
import test from "node:test";

import { CHECKS_SKIP_ENV } from "./checks.ts";
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
  assert.match(result.stdout, /Checks: 6 passed, 4 failed\./);
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
  assert.equal(passing.stdout, "Checks: 10 passed, 0 failed.\n");
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
  assert.equal(result.stdout, "Checks: 9 passed, 0 failed.\n");
});

const ALL_STEPS = [
  "typecheck",
  "lint",
  "format:check",
  "knip",
  "test",
  "size",
  "ratchet",
  "suppressions",
  "sync:check",
];

function stepsRepo(t: Parameters<typeof testRepo>[0], failing: string[]) {
  const root = testRepo(t);
  put(root, "guardrails.ratchet.json", '{"rules":{},"oversizeFiles":{}}');
  const scripts = Object.fromEntries(
    ALL_STEPS.map((name) => [
      name,
      failing.includes(name)
        ? `node -e "console.error('${name} ran');process.exit(1)"`
        : 'node -e "process.exit(0)"',
    ]),
  );
  put(
    root,
    "package.json",
    JSON.stringify({ packageManager: "npm@11.0.0", scripts }),
  );
  return root;
}

test("ANTELOPEJS_CHECKS_SKIP leaves the named steps unrun and reports them as skipped, not passed", (t) => {
  const root = stepsRepo(t, ["test", "size"]);
  const result = bin(root, "checks", [], {
    ANTELOPEJS_CHECKS_SKIP: " test , size ",
  });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "Checks: 8 passed, 0 failed, 2 skipped.\n");
});

test("ANTELOPEJS_CHECKS_SKIP still runs the steps it does not name", (t) => {
  const root = stepsRepo(t, ["test", "lint"]);
  const result = bin(root, "checks", [], { ANTELOPEJS_CHECKS_SKIP: "test" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /lint ran/);
  assert.doesNotMatch(result.stdout, /test ran/);
  assert.match(result.stdout, /Checks: 8 passed, 1 failed, 1 skipped\./);
});

test("an unknown ANTELOPEJS_CHECKS_SKIP name fails and names the valid steps instead of skipping nothing", (t) => {
  const root = stepsRepo(t, []);
  const result = bin(root, "checks", [], {
    ANTELOPEJS_CHECKS_SKIP: "tset,test",
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Unknown step "tset"/);
  assert.match(
    result.stdout,
    /Valid steps: typecheck, lint, format:check, knip, test, size, ratchet, suppressions, sync:check, verify:types, verify:lockfiles, lockfile:singletons, git:identity\./,
  );
});

test("a checks skip set in the test runner's own environment does not reach the bin under test", (t) => {
  const previous = process.env[CHECKS_SKIP_ENV];
  process.env[CHECKS_SKIP_ENV] = "test";
  t.after(() => {
    if (previous === undefined) delete process.env[CHECKS_SKIP_ENV];
    else process.env[CHECKS_SKIP_ENV] = previous;
  });
  const root = stepsRepo(t, ["test"]);
  const result = bin(root, "checks");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Checks: 9 passed, 1 failed\./);
});

test("an unset, empty or blank ANTELOPEJS_CHECKS_SKIP runs every step", (t) => {
  const root = stepsRepo(t, ["test"]);
  const settings: Record<string, string>[] = [
    {},
    { ANTELOPEJS_CHECKS_SKIP: "" },
    { ANTELOPEJS_CHECKS_SKIP: " , " },
  ];
  for (const env of settings) {
    const result = bin(root, "checks", [], env);
    assert.equal(result.status, 1, JSON.stringify(env));
    assert.match(result.stdout, /Checks: 9 passed, 1 failed\./);
  }
});
