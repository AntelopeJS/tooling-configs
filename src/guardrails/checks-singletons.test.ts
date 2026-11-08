import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { stringify } from "yaml";

import { bin, put, testRepo } from "./helpers/test-repo.ts";

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

/** A repository whose every script step passes, so only the lockfiles decide the run. */
function passingRepo(t: TestContext): string {
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
  return root;
}

/** The lockfile of a consumer whose direct `@antelopejs/interface-core` row stays below the one `@antelopejs/core` resolves. */
const TWO_CORES = stringify({
  lockfileVersion: "9.0",
  settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
  importers: {
    ".": {
      dependencies: {
        "@antelopejs/core": { specifier: "^1.17.0", version: "1.17.2" },
        "@antelopejs/interface-core": {
          specifier: "^0.1.1",
          version: "0.1.1",
        },
        "@antelopejs/interface-api": {
          specifier: "^0.1.0",
          version: "0.1.0(@antelopejs/interface-core@0.1.1)",
        },
      },
    },
  },
  packages: {
    "@antelopejs/core@1.17.2": { resolution: { integrity: "sha512-a" } },
    "@antelopejs/interface-api@0.1.0": {
      resolution: { integrity: "sha512-b" },
      peerDependencies: { "@antelopejs/interface-core": "*" },
    },
    "@antelopejs/interface-core@0.1.1": {
      resolution: { integrity: "sha512-c" },
    },
    "@antelopejs/interface-core@0.2.6": {
      resolution: { integrity: "sha512-d" },
    },
  },
  snapshots: {
    "@antelopejs/core@1.17.2": {
      dependencies: { "@antelopejs/interface-core": "0.2.6" },
    },
    "@antelopejs/interface-api@0.1.0(@antelopejs/interface-core@0.1.1)": {
      dependencies: { "@antelopejs/interface-core": "0.1.1" },
    },
    "@antelopejs/interface-core@0.1.1": {},
    "@antelopejs/interface-core@0.2.6": {},
  },
});

test("a lockfile holding two copies of an interface package fails checks and names who pulls each, caught by a run that never reads resolved rows", (t) => {
  const root = passingRepo(t);
  put(root, "pnpm-lock.yaml", TWO_CORES);
  const result = bin(root, "checks");
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /\[lockfile:singletons\]\npnpm-lock\.yaml resolves "@antelopejs\/interface-core" at 2 versions, and an interface package must load once:\n {2}0\.1\.1, pulled by importer "\.", @antelopejs\/interface-api@0\.1\.0\n {2}0\.2\.6, pulled by @antelopejs\/core@1\.17\.2\n/,
  );
  assert.match(result.stdout, /Checks: 8 passed, 1 failed\./);
});
