import assert from "node:assert/strict";
import test from "node:test";

import { findingsFor } from "./helpers/coverage-repo.ts";

const FULL = { typecheck: "tsc --noEmit" };
const RELEASE = /^package\.json: script "release" does not run "typecheck"/;

test("a typecheck in a release-it hook that runs before publishing counts, in .release-it.json and in package.json; a check that reads only the release script reports the 31 repositories that keep it there", (t) => {
  for (const hook of ["before:init", "before:bump", "before:release"])
    assert.deepEqual(
      findingsFor(
        t,
        { release: "release-it", ...FULL },
        {
          ".release-it.json": JSON.stringify({
            hooks: { [hook]: "pnpm run typecheck" },
          }),
        },
      ),
      [],
      hook,
    );
  assert.deepEqual(
    findingsFor(
      t,
      { release: "release-it", ...FULL },
      {
        ".release-it.json": `{ // lists run in order\n "hooks": { "before:init": ["pnpm run lint", "pnpm run typecheck"], }, }`,
      },
    ),
    [],
  );
  assert.deepEqual(
    findingsFor(
      t,
      { release: "release-it", ...FULL },
      {},
      { "release-it": { hooks: { "before:init": "pnpm run typecheck" } } },
    ),
    [],
  );
});

test("a typecheck in a release-it hook that runs after publishing, or in no hook, does not count; a check that accepts any hook or any mention in the config passes both", (t) => {
  const after = findingsFor(
    t,
    { release: "release-it", ...FULL },
    {
      ".release-it.json": JSON.stringify({
        hooks: { "after:release": "pnpm run typecheck" },
      }),
    },
  );
  assert.match(after[0], RELEASE);
  const elsewhere = findingsFor(
    t,
    { release: "release-it", ...FULL },
    {
      ".release-it.json": JSON.stringify({
        git: { commitMessage: "pnpm run typecheck" },
      }),
    },
  );
  assert.match(elsewhere[0], RELEASE);
});

test("a prerelease script that runs typecheck counts for release; a check that follows only explicit script calls reports it", (t) => {
  assert.deepEqual(
    findingsFor(t, {
      prerelease: "pnpm run lint && pnpm run typecheck",
      release: "release-it",
      ...FULL,
    }),
    [],
  );
});

test("a prebuild script that carries --skipLibCheck is a build that skips it; a check that reads only the build script passes it", (t) => {
  const findings = findingsFor(t, {
    prebuild: "tsc --skipLibCheck -p tsconfig.build.json",
    build: "rimraf dist",
    ...FULL,
  });
  assert.match(findings.join("\n"), /script "build" passes --skipLibCheck/);
});

test("run-s and npm-run-all name the scripts they run, patterns included; a check that sees only package-manager calls reports release scripts built on them", (t) => {
  for (const release of [
    "run-s lint typecheck release:publish",
    "npm-run-all lint typecheck release:publish",
    "run-s --silent lint type* release:publish",
    "run-s lint verify release:publish",
  ])
    assert.deepEqual(
      findingsFor(t, {
        release,
        verify: "pnpm run typecheck",
        ...FULL,
      }),
      [],
      release,
    );
  assert.match(
    findingsFor(t, { release: "run-s lint release:publish", ...FULL })[0],
    RELEASE,
  );
});

test("cross-env, env assignments and parentheses in front of a package-manager call do not hide it; a check that reads only the first word reports them", (t) => {
  for (const release of [
    "cross-env CI=1 pnpm run typecheck && release-it",
    "cross-env CI=1 NODE_ENV=production pnpm typecheck && release-it",
    "CI=1 pnpm run typecheck && release-it",
    "(pnpm run typecheck) && release-it",
    "(pnpm run lint && pnpm run typecheck); release-it",
    "pnpm run typecheck | cat && release-it",
  ])
    assert.deepEqual(findingsFor(t, { release, ...FULL }), [], release);
});

test("pnpm and npm options with a value do not make the value the script name; a check that takes the first word after the manager reports these and one that takes the filter value as a script passes a release that never runs typecheck", (t) => {
  for (const release of [
    "pnpm --filter app run typecheck && release-it",
    "pnpm run --filter app typecheck && release-it",
    "pnpm -C packages/app run typecheck && release-it",
    "pnpm --dir packages/app typecheck && release-it",
    "pnpm --filter=app run typecheck && release-it",
    "npm run --silent typecheck && release-it",
    "npm --prefix . run typecheck && release-it",
  ])
    assert.deepEqual(findingsFor(t, { release, ...FULL }), [], release);
  assert.match(
    findingsFor(t, {
      release: "pnpm --filter typecheck run lint && release-it",
      ...FULL,
    })[0],
    RELEASE,
  );
});
