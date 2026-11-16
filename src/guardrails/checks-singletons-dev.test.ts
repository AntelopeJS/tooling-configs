import assert from "node:assert/strict";
import test from "node:test";
import { stringify } from "yaml";

import { put, testRepo } from "./helpers/test-repo.ts";
import { checkSingletonPackages } from "./singleton-packages.ts";

const BUILDER = "@antelopejs/interface-dms-builder";

const TOOLS = "@antelopejs/test-tools";

/** A version 9 lockfile where `@antelopejs/core` locks interface-core 0.2.6 and the importer's `field` pulls a tool that locks 0.1.1. */
function toolLock(field: "dependencies" | "devDependencies"): string {
  return stringify({
    lockfileVersion: "9.0",
    importers: {
      ".": {
        dependencies: {
          "@antelopejs/core": { specifier: "^1.17.0", version: "1.17.2" },
        },
        [field]: { [TOOLS]: { specifier: "^1.0.0", version: "1.0.0" } },
      },
    },
    packages: {
      "@antelopejs/core@1.17.2": {},
      [`${TOOLS}@1.0.0`]: {},
      "@antelopejs/interface-core@0.1.1": {},
      "@antelopejs/interface-core@0.2.6": {},
    },
    snapshots: {
      "@antelopejs/core@1.17.2": {
        dependencies: { "@antelopejs/interface-core": "0.2.6" },
      },
      [`${TOOLS}@1.0.0`]: {
        dependencies: { "@antelopejs/interface-core": "0.1.1" },
      },
      "@antelopejs/interface-core@0.1.1": {},
      "@antelopejs/interface-core@0.2.6": {},
    },
  });
}

test("a second copy only a devDependency reaches passes and the same copy a dependency reaches fails, where a check that counts every locked copy fails a copy no production install ships", (t) => {
  const root = testRepo(t);
  put(root, "pnpm-lock.yaml", toolLock("devDependencies"));
  assert.equal(checkSingletonPackages(root), "");
  put(root, "pnpm-lock.yaml", toolLock("dependencies"));
  assert.match(
    checkSingletonPackages(root),
    /at 2 versions, and an interface package must load once:\n {2}0\.1\.1, pulled by @antelopejs\/test-tools@1\.0\.0\n {2}0\.2\.6, pulled by @antelopejs\/core@1\.17\.2\n/,
  );
});

test("a version 6 nested lockfile reports only the copies and pullers runtime dependencies reach, where a report that keeps devDependency pullers says 4 versions and names a dev tool", (t) => {
  const root = testRepo(t);
  put(
    root,
    "modules/api/pnpm-lock.yaml",
    stringify({
      lockfileVersion: "6.0",
      dependencies: {
        "@antelopejs/interface-core": { specifier: "^0.1.1", version: "0.1.1" },
        "@antelopejs/core": { specifier: "^1.17.0", version: "1.17.2" },
      },
      devDependencies: {
        [TOOLS]: { specifier: "^1.0.0", version: "1.0.0" },
        "@antelopejs/interface-core-legacy": {
          specifier: "npm:@antelopejs/interface-core@0.0.9",
          version: "/@antelopejs/interface-core@0.0.9",
        },
      },
      packages: {
        "/@antelopejs/core@1.17.2": {
          dependencies: { "@antelopejs/interface-core": "0.2.6" },
        },
        [`/${TOOLS}@1.0.0`]: {
          dev: true,
          dependencies: {
            "@antelopejs/interface-core": "0.1.1",
            "@antelopejs/interface-core-old":
              "/@antelopejs/interface-core@0.0.8",
          },
        },
        "/@antelopejs/interface-core@0.0.8": { dev: true },
        "/@antelopejs/interface-core@0.0.9": { dev: true },
        "/@antelopejs/interface-core@0.1.1": {},
        "/@antelopejs/interface-core@0.2.6": {},
      },
    }),
  );
  assert.equal(
    checkSingletonPackages(root),
    'modules/api/pnpm-lock.yaml resolves "@antelopejs/interface-core" at 2 versions, and an interface package must load once:\n' +
      '  0.1.1, pulled by importer "."\n' +
      "  0.2.6, pulled by @antelopejs/core@1.17.2\n" +
      "  Set the direct specifier that locks the older copy to the newer version, run `pnpm install --lockfile-only`, then restore the specifier.\n",
  );
});

test("a devDependency the manifest also lists as a peer reaches its copies at runtime, where a check that trusts the lockfile's devDependencies alone passes the core a host loads beside the module's interface", (t) => {
  const root = testRepo(t);
  put(
    root,
    "modules/api/pnpm-lock.yaml",
    stringify({
      lockfileVersion: "9.0",
      importers: {
        ".": {
          dependencies: {
            "@antelopejs/interface-core": {
              specifier: ">=0.5.1 <0.6.0",
              version: "0.5.1",
            },
          },
          devDependencies: {
            "@antelopejs/core": { specifier: "~1.25.0", version: "1.25.0" },
          },
        },
      },
      packages: {
        "@antelopejs/core@1.25.0": {},
        "@antelopejs/interface-core@0.5.1": {},
        "@antelopejs/interface-core@0.6.0": {},
      },
      snapshots: {
        "@antelopejs/core@1.25.0": {
          dependencies: { "@antelopejs/interface-core": "0.6.0" },
        },
        "@antelopejs/interface-core@0.5.1": {},
        "@antelopejs/interface-core@0.6.0": {},
      },
    }),
  );
  const manifest = (peers: Record<string, string>): string =>
    JSON.stringify({
      peerDependencies: peers,
      devDependencies: { "@antelopejs/core": "~1.25.0" },
    });
  put(root, "modules/api/package.json", manifest({}));
  assert.equal(checkSingletonPackages(root), "");
  put(
    root,
    "modules/api/package.json",
    manifest({ "@antelopejs/core": "~1.25.0" }),
  );
  assert.match(
    checkSingletonPackages(root),
    /\n {2}0\.5\.1, pulled by importer "\."\n {2}0\.6\.0, pulled by @antelopejs\/core@1\.25\.0\n/,
  );
  put(root, "modules/api/package.json", "{");
  assert.match(checkSingletonPackages(root), /at 2 versions/);
});

test("a preview a devDependency pins beside a release on its minor passes when a runtime package locks the same preview, where a check that drops the importer's devDependency pins loses the pin that exempts it", (t) => {
  const root = testRepo(t);
  const preview = "0.5.2-next.926.gdaa3203";
  put(
    root,
    "pnpm-lock.yaml",
    stringify({
      lockfileVersion: "9.0",
      importers: {
        ".": {
          dependencies: {
            "@antelopejs/dms": { specifier: "0.20.5", version: "0.20.5" },
            "@antelopejs/other": { specifier: "1.0.0", version: "1.0.0" },
          },
          devDependencies: {
            [BUILDER]: { specifier: preview, version: preview },
          },
        },
      },
      packages: {
        "@antelopejs/dms@0.20.5": {},
        "@antelopejs/other@1.0.0": {},
        [`${BUILDER}@${preview}`]: {},
        [`${BUILDER}@0.5.0`]: {},
      },
      snapshots: {
        "@antelopejs/dms@0.20.5": { dependencies: { [BUILDER]: "0.5.0" } },
        "@antelopejs/other@1.0.0": { dependencies: { [BUILDER]: preview } },
        [`${BUILDER}@${preview}`]: {},
        [`${BUILDER}@0.5.0`]: {},
      },
    }),
  );
  assert.equal(checkSingletonPackages(root), "");
});
