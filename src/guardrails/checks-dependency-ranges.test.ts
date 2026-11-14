import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { freePort } from "../verify/record.ts";
import { stubRegistry } from "./helpers/registry.ts";
import { binAsync, commit, put, testRepo } from "./helpers/test-repo.ts";

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

const AUTOMATION = "@antelopejs/interface-dms-automation";

/** A committed repository whose every script step passes and whose playground declares `range` on an interface, so only that range decides the run. */
function repoWithRange(
  t: TestContext,
  range: string,
  field = "dependencies",
  name = "@antelopejs/interface-database",
): string {
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
      [field]: { [name]: range },
    }),
  );
  commit(root);
  return root;
}

/** Runs checks against the registry at `url`, without blocking the event loop a stub registry answers from. */
function checks(root: string, url: string) {
  return binAsync(root, "checks", [], {
    npm_config_registry: url,
    NPM_CONFIG_REGISTRY: url,
  });
}

test("an open 0.x range in a nested manifest fails checks with its fix, where a run without the dependency:ranges step passes the range that resolves a breaking minor", async (t) => {
  const result = await checks(
    repoWithRange(t, ">=0.3.0 <1.0.0"),
    await stubRegistry(t, { "@antelopejs/interface-database": "1.2.0" }),
  );
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /\[dependency:ranges\]\nplayground\/package\.json: dependencies\["@antelopejs\/interface-database"\] is ">=0\.3\.0 <1\.0\.0": .*; use ">=0\.3\.0 <0\.4\.0"\n/,
  );
  assert.match(result.stdout, /Checks: 9 passed, 1 failed\./);
  assert.equal(
    result.stdout.match(/interface-database/g)?.length,
    1,
    result.stdout,
  );
});

test("a range capped below the next minor passes checks, where a step that reports every AntelopeJS range fails a repository that already complies", async (t) => {
  const result = await checks(
    repoWithRange(t, ">=0.3.0 <0.4.0"),
    await stubRegistry(t, { "@antelopejs/interface-database": "0.3.4" }),
  );
  assert.equal(result.status, 0, result.stdout);
});

test("an optional interface range that no longer admits its newest published release fails checks with its fix, where a step that only checks the cap passes the range a project running the new minor cannot start with", async (t) => {
  const root = repoWithRange(
    t,
    ">=0.6.0 <0.7.0",
    "optionalDependencies",
    AUTOMATION,
  );
  const result = await checks(
    root,
    await stubRegistry(t, { [AUTOMATION]: "0.7.0" }),
  );
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /\[dependency:ranges\]\nplayground\/package\.json: optionalDependencies\["@antelopejs\/interface-dms-automation"\] is ">=0\.6\.0 <0\.7\.0", which stops below 0\.7\.0, its newest published version, .*; use ">=0\.7\.0 <0\.8\.0"\n/,
  );
});

test("an optional interface range on the newest published minor passes checks, where a step that demands the newest release as the floor fails a range that admits it", async (t) => {
  const root = repoWithRange(
    t,
    ">=0.7.0 <0.8.0",
    "optionalDependencies",
    AUTOMATION,
  );
  const result = await checks(
    root,
    await stubRegistry(t, { [AUTOMATION]: "0.7.0" }),
  );
  assert.equal(result.status, 0, result.stdout);
});

test("an unreachable registry leaves a capped interface range passing, where a step that fails on an unread release turns a registry outage into a red build", async (t) => {
  const root = repoWithRange(t, ">=0.6.0 <0.7.0", "dependencies", AUTOMATION);
  const result = await checks(root, `http://127.0.0.1:${await freePort()}/`);
  assert.equal(result.status, 0, result.stdout);
});

test("a capped range whose floor is above the newest published release passes, where a step that demands the range admit that release tells a module on an unreleased minor to downgrade", async (t) => {
  const root = repoWithRange(t, ">=0.8.0 <0.9.0", "dependencies", AUTOMATION);
  const result = await checks(
    root,
    await stubRegistry(t, { [AUTOMATION]: "0.7.3" }),
  );
  assert.equal(result.status, 0, result.stdout);
});

test("a capped range on an AntelopeJS package that is not an interface passes behind its newest release, where a step that reads every AntelopeJS package fails a module range core does not resolve as a singleton", async (t) => {
  const root = repoWithRange(
    t,
    ">=0.3.0 <0.4.0",
    "dependencies",
    "@antelopejs/mongodb",
  );
  const result = await checks(
    root,
    await stubRegistry(t, { "@antelopejs/mongodb": "0.4.0" }),
  );
  assert.equal(result.status, 0, result.stdout);
});
