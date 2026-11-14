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

test("a range on an interface the repository holds follows the version there, not the registry, where a step that reads every interface from the registry fails a branch cut before the interface's release", async (t) => {
  const root = repoWithRange(t, ">=0.6.0 <0.7.0", "dependencies", AUTOMATION);
  put(
    root,
    "interface/package.json",
    JSON.stringify({ name: AUTOMATION, version: "0.6.3" }),
  );
  commit(root);
  const result = await checks(
    root,
    await stubRegistry(t, { [AUTOMATION]: "0.7.0" }),
  );
  assert.equal(result.status, 0, result.stdout);
});

test("a prerelease newest version leaves the range passing, where a step that reads the prerelease as its release tells the module to move to a minor no release satisfies yet", async (t) => {
  const root = repoWithRange(t, ">=0.6.0 <0.7.0", "dependencies", AUTOMATION);
  const result = await checks(
    root,
    await stubRegistry(t, { [AUTOMATION]: "0.7.0-beta.1" }),
  );
  assert.equal(result.status, 0, result.stdout);
});

test("a capped range semver cannot parse finishes the run, where a step that hands it to semver unguarded crashes checks before any summary", async (t) => {
  const root = repoWithRange(t, ">=0.06.0 <0.07.0", "dependencies", AUTOMATION);
  const result = await checks(
    root,
    await stubRegistry(t, { [AUTOMATION]: "0.7.0" }),
  );
  assert.match(result.stdout, /Checks: \d+ passed/);
});

/** The newest release of a DMS package that implements `name` on `range`. */
function implementing(name: string, version: string, range: string) {
  return {
    name: name === AUTOMATION ? "@antelopejs/dms-automation" : name,
    version,
    antelopeJs: { implements: [name] },
    dependencies: { [name]: range },
  };
}

test("a range that excludes the interface version the newest release of its DMS module implements fails checks with that version's range, where a step that reads only the interface's own newest release passes a module a project running that DMS module cannot start", async (t) => {
  const root = repoWithRange(t, ">=0.8.0 <0.9.0", "dependencies", AUTOMATION);
  const result = await checks(
    root,
    await stubRegistry(
      t,
      { [AUTOMATION]: "0.8.0" },
      {
        "@antelopejs/dms-automation": implementing(
          AUTOMATION,
          "0.11.1",
          ">=0.7.0 <0.8.0",
        ),
      },
    ),
  );
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /\[dependency:ranges\]\nplayground\/package\.json: dependencies\["@antelopejs\/interface-dms-automation"\] is ">=0\.8\.0 <0\.9\.0", which excludes ">=0\.7\.0 <0\.8\.0", the range @antelopejs\/dms-automation 0\.11\.1, its newest release, implements it on, .*; use ">=0\.7\.0 <0\.8\.0"\n/,
  );
});

test("a range on the interface the DMS core implements is held to the core's newest release, where a step that finds providers by the interface's name alone misses @antelopejs/dms", async (t) => {
  const name = "@antelopejs/interface-dms-builder";
  const root = repoWithRange(t, ">=0.3.0 <0.4.0", "dependencies", name);
  const result = await checks(
    root,
    await stubRegistry(
      t,
      { [name]: "0.3.0" },
      { "@antelopejs/dms": implementing(name, "0.20.0", ">=0.2.0 <0.3.0") },
    ),
  );
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /@antelopejs\/dms 0\.20\.0/);
});

test("a range that admits the interface version the newest DMS release implements passes, where a step that demands an equal range fails a module on the same minor", async (t) => {
  const root = repoWithRange(t, "~0.7.1", "dependencies", AUTOMATION);
  const result = await checks(
    root,
    await stubRegistry(
      t,
      { [AUTOMATION]: "0.7.1" },
      {
        "@antelopejs/dms-automation": implementing(
          AUTOMATION,
          "0.11.1",
          ">=0.7.0 <0.8.0",
        ),
      },
    ),
  );
  assert.equal(result.status, 0, result.stdout);
});

test("a DMS module the repository holds is not read from the registry, where a step that reads its published release fails a branch that moves the module to a new interface minor", async (t) => {
  const root = repoWithRange(t, ">=0.8.0 <0.9.0", "dependencies", AUTOMATION);
  put(
    root,
    "module/package.json",
    JSON.stringify({
      name: "@antelopejs/dms-automation",
      version: "0.12.0",
      private: true,
      dependencies: { [AUTOMATION]: ">=0.8.0 <0.9.0" },
    }),
  );
  commit(root);
  const result = await checks(
    root,
    await stubRegistry(
      t,
      { [AUTOMATION]: "0.8.0" },
      {
        "@antelopejs/dms-automation": implementing(
          AUTOMATION,
          "0.11.1",
          ">=0.7.0 <0.8.0",
        ),
      },
    ),
  );
  assert.equal(result.status, 0, result.stdout);
});

test("a range behind two DMS releases that implement the interface on one range prints one line, where a step that reports each provider apart repeats the fix", async (t) => {
  const root = repoWithRange(t, ">=0.6.0 <0.7.0", "dependencies", AUTOMATION);
  const result = await checks(
    root,
    await stubRegistry(
      t,
      { [AUTOMATION]: "0.7.0" },
      {
        "@antelopejs/dms-automation": implementing(
          AUTOMATION,
          "0.11.1",
          ">=0.7.0 <0.8.0",
        ),
        "@antelopejs/dms-api": {
          ...implementing(AUTOMATION, "0.4.0", ">=0.7.0 <0.8.0"),
          name: "@antelopejs/dms-api",
        },
      },
    ),
  );
  assert.equal(result.status, 1, result.stdout);
  assert.equal(result.stdout.match(/use ">=0\.7\.0 <0\.8\.0"/g)?.length, 1);
});

test("a range that shares a release with the second arm of a DMS release's range passes, where a step that compares only the lowest release of each range fails it", async (t) => {
  const root = repoWithRange(t, ">=0.7.0 <0.8.0", "dependencies", AUTOMATION);
  const result = await checks(
    root,
    await stubRegistry(
      t,
      { [AUTOMATION]: "0.7.3" },
      {
        "@antelopejs/dms-automation": implementing(
          AUTOMATION,
          "0.11.1",
          ">=0.6.0 <0.7.0 || >=0.7.3 <0.8.0",
        ),
      },
    ),
  );
  assert.equal(result.status, 0, result.stdout);
});

test("a range on the minor before a provider's prerelease floor fails, where a step that counts ranges meeting only at a prerelease as overlapping passes a module that resolves no version the provider admits", async (t) => {
  const root = repoWithRange(t, ">=0.9.0 <0.10.0", "dependencies", AUTOMATION);
  const result = await checks(
    root,
    await stubRegistry(
      t,
      { [AUTOMATION]: "0.9.0" },
      {
        "@antelopejs/dms-automation": implementing(
          AUTOMATION,
          "0.12.1",
          "^0.10.0-rc.1",
        ),
      },
    ),
  );
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /use ">=0\.10\.0 <0\.11\.0"/);
});

test("a range on the minor the newest DMS release implements passes while the interface has a newer minor, where a step that also demands the interface's newest release leaves no range that passes until the module catches up", async (t) => {
  const root = repoWithRange(t, ">=0.7.0 <0.8.0", "dependencies", AUTOMATION);
  const result = await checks(
    root,
    await stubRegistry(
      t,
      { [AUTOMATION]: "0.8.0" },
      {
        "@antelopejs/dms-automation": implementing(
          AUTOMATION,
          "0.11.1",
          ">=0.7.0 <0.8.0",
        ),
      },
    ),
  );
  assert.equal(result.status, 0, result.stdout);
});

test("a DMS release whose range on the interface semver cannot read leaves the interface's newest release deciding, where a step that hands that range to semver crashes checks before any summary", async (t) => {
  const root = repoWithRange(t, ">=0.6.0 <0.7.0", "dependencies", AUTOMATION);
  const result = await checks(
    root,
    await stubRegistry(
      t,
      { [AUTOMATION]: "0.7.0" },
      {
        "@antelopejs/dms-automation": implementing(
          AUTOMATION,
          "0.11.1",
          ">=0.7.0 <y",
        ),
      },
    ),
  );
  assert.match(result.stdout, /Checks: 9 passed, 1 failed\./);
  assert.match(result.stdout, /its newest published version/);
});

test("a prerelease newest DMS release does not decide the range, where a step that reads it as a release fails a module on the interface's newest minor", async (t) => {
  const root = repoWithRange(t, ">=0.8.0 <0.9.0", "dependencies", AUTOMATION);
  const result = await checks(
    root,
    await stubRegistry(
      t,
      { [AUTOMATION]: "0.8.0" },
      {
        "@antelopejs/dms-automation": implementing(
          AUTOMATION,
          "0.12.0-beta.1",
          ">=0.7.0 <0.8.0",
        ),
      },
    ),
  );
  assert.equal(result.status, 0, result.stdout);
});
