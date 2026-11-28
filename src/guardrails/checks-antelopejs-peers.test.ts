import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { stringify } from "yaml";

import { checkAntelopejsPeers } from "./antelopejs-peers.ts";
import { fixture } from "./helpers/ci-text.ts";
import { bin, put, testRepo } from "./helpers/test-repo.ts";

/** The lockfile of template-dms-demo a744aff, where Renovate moved oxlint to 1.95.0 and oxfmt to 0.80.0 past the peers of the locked `@antelopejs/tooling-configs@0.10.7`. */
const DMS_DEMO_A744AFF = fixture("template-dms-demo-a744aff-pnpm-lock.yaml");

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

/** A repository whose every script step passes, so only the lockfile decides the run. */
function passingRepo(t: TestContext): string {
  const root = testRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({
      packageManager: "pnpm@10.33.0",
      scripts: Object.fromEntries(
        PASSING_STEPS.map((name) => [name, 'node -e "process.exit(0)"']),
      ),
    }),
  );
  put(
    root,
    "pnpm-workspace.yaml",
    'minimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - "@antelopejs/*"\n',
  );
  return root;
}

/** `text` with `from` replaced, asserting it occurs exactly once. */
function replaceOnce(text: string, from: string, to: string): string {
  assert.equal(text.split(from).length, 2, from);
  return text.replace(from, to);
}

test("template-dms-demo a744aff, oxlint and oxfmt locked past the tooling-configs peers, fails checks naming each peer, caught by a check that compares specifiers or never reads the package entry's peerDependencies", (t) => {
  const root = passingRepo(t);
  put(root, "pnpm-lock.yaml", DMS_DEMO_A744AFF);
  const result = bin(root, "checks");
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /\[lockfile:antelopejs-peers\]\npnpm-lock\.yaml locks "oxfmt" at 0\.80\.0, outside "\^0\.66\.0 \|\| \^0\.77\.0 \|\| \^0\.79\.0", the range @antelopejs\/tooling-configs@0\.10\.7 declares in peerDependencies\. Keep oxfmt at a version in that range, or move @antelopejs\/tooling-configs to a release that lists 0\.80\.0\.\npnpm-lock\.yaml locks "oxlint" at 1\.95\.0, outside "1\.81\.0 \|\| 1\.94\.0", the range @antelopejs\/tooling-configs@0\.10\.7 declares in peerDependencies\. Keep oxlint at a version in that range, or move @antelopejs\/tooling-configs to a release that lists 1\.95\.0\.\n/,
  );
});

test("the same lockfile with oxlint and oxfmt at versions the peers list passes, caught by a check that fails every locked peer of an @antelopejs package", (t) => {
  const root = testRepo(t);
  const inRange = replaceOnce(
    replaceOnce(
      DMS_DEMO_A744AFF,
      "specifier: 1.95.0\n        version: 1.95.0(",
      "specifier: 1.94.0\n        version: 1.94.0(",
    ),
    "specifier: ^0.80.0\n        version: 0.80.0",
    "specifier: ^0.79.0\n        version: 0.79.0",
  );
  put(root, "pnpm-lock.yaml", inRange);
  assert.equal(checkAntelopejsPeers(root), "");
});

test("a workspace importer locking a peer outside the range is named, while the root importer inside it passes, caught by a check that reads the root importer only", (t) => {
  const root = testRepo(t);
  const configs = (oxlint: string) => ({
    dependencies: {
      "@antelopejs/tooling-configs": {
        specifier: "^0.10.7",
        version: `0.10.7(oxlint@${oxlint})`,
      },
      oxlint: { specifier: oxlint, version: oxlint },
    },
  });
  put(
    root,
    "pnpm-lock.yaml",
    stringify({
      lockfileVersion: "9.0",
      importers: { ".": configs("1.94.0"), "packages/a": configs("1.95.0") },
      packages: {
        "@antelopejs/tooling-configs@0.10.7": {
          peerDependencies: { oxlint: "1.81.0 || 1.94.0" },
        },
        "oxlint@1.94.0": {},
        "oxlint@1.95.0": {},
      },
    }),
  );
  assert.equal(
    checkAntelopejsPeers(root),
    'pnpm-lock.yaml importer "packages/a" locks "oxlint" at 1.95.0, outside "1.81.0 || 1.94.0", the range @antelopejs/tooling-configs@0.10.7 declares in peerDependencies. Keep oxlint at a version in that range, or move @antelopejs/tooling-configs to a release that lists 1.95.0.\n',
  );
});

test("a peer range semver cannot parse is left alone, where a check that hands every range to semver throws and stops the checks run", (t) => {
  const root = testRepo(t);
  put(
    root,
    "pnpm-lock.yaml",
    stringify({
      lockfileVersion: "9.0",
      importers: {
        ".": {
          dependencies: {
            "@antelopejs/tooling-configs": {
              specifier: "^0.10.7",
              version: "0.10.7(oxlint@1.95.0)",
            },
            oxlint: { specifier: "1.95.0", version: "1.95.0" },
          },
        },
      },
      packages: {
        "@antelopejs/tooling-configs@0.10.7": {
          peerDependencies: { oxlint: "latest" },
        },
        "oxlint@1.95.0": {},
      },
    }),
  );
  assert.equal(checkAntelopejsPeers(root), "");
});
