import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { stringify } from "yaml";

import { bin, put, testRepo } from "./helpers/test-repo.ts";
import { checkSingletonPackages } from "./singleton-packages.ts";

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

test("one interface copy under two peer contexts and two copies of a package that is not an interface pass, caught by counting snapshot keys or flagging any duplicate", (t) => {
  const root = testRepo(t);
  put(
    root,
    "pnpm-lock.yaml",
    stringify({
      lockfileVersion: "9.0",
      importers: {
        ".": {
          dependencies: {
            "@antelopejs/interface-core": {
              specifier: "^0.2.6",
              version: "0.2.6(typescript@5.9.3)",
            },
            "left-pad": { specifier: "^1.3.0", version: "1.3.0" },
          },
        },
      },
      packages: {
        "@antelopejs/interface-core@0.2.6": {},
        "left-pad@1.3.0": {},
        "left-pad@1.2.0": {},
      },
      snapshots: {
        "@antelopejs/interface-core@0.2.6(typescript@5.9.3)": {
          dependencies: { "left-pad": "1.2.0" },
        },
        "@antelopejs/interface-core@0.2.6(typescript@5.8.0)": {},
        "left-pad@1.3.0": {},
        "left-pad@1.2.0": {},
      },
    }),
  );
  assert.equal(checkSingletonPackages(root), "");
});

test("a version 6 lockfile in a nested folder holding two copies fails, caught by reading only the root or only version 9 keys", (t) => {
  const root = testRepo(t);
  put(
    root,
    "playground/pnpm-lock.yaml",
    stringify({
      lockfileVersion: "6.0",
      dependencies: {
        "@antelopejs/interface-database": {
          specifier: "^0.2.4",
          version: "0.2.4",
        },
      },
      packages: {
        "/@antelopejs/interface-database@0.2.4": {},
        "/@antelopejs/interface-database@0.2.6": {},
        "/@antelopejs/mongodb@1.0.0(@antelopejs/interface-database@0.2.6)": {
          dependencies: { "@antelopejs/interface-database": "0.2.6" },
        },
      },
    }),
  );
  assert.equal(
    checkSingletonPackages(root),
    'playground/pnpm-lock.yaml resolves "@antelopejs/interface-database" at 2 versions, and an interface package must load once:\n' +
      '  0.2.4, pulled by importer "."\n' +
      "  0.2.6, pulled by @antelopejs/mongodb@1.0.0\n" +
      "  Set the direct specifier that locks the older copy to the newer version, run `pnpm install --lockfile-only`, then restore the specifier.\n",
  );
});

test("a copy an importer pulls through an npm: alias names that importer, caught by matching dependency keys against interface names only", (t) => {
  const root = testRepo(t);
  put(
    root,
    "pnpm-lock.yaml",
    stringify({
      lockfileVersion: "9.0",
      importers: {
        ".": {
          dependencies: {
            "@antelopejs/interface-core": {
              specifier: "^0.2.6",
              version: "0.2.6",
            },
            "old-core": {
              specifier: "npm:@antelopejs/interface-core@^0.1.1",
              version: "@antelopejs/interface-core@0.1.1",
            },
          },
        },
      },
      packages: {
        "@antelopejs/interface-core@0.1.1": {},
        "@antelopejs/interface-core@0.2.6": {},
      },
    }),
  );
  assert.match(
    checkSingletonPackages(root),
    /\n {2}0\.1\.1, pulled by importer "\."\n {2}0\.2\.6, pulled by importer "\."\n/,
  );
});

const CONFIG_DOCUMENT = stringify({
  lockfileVersion: "9.0",
  importers: {
    ".": {
      configDependencies: {
        "@pnpm/plugin-better-defaults": {
          specifier: "0.3.0",
          version: "0.3.0",
        },
      },
    },
  },
  packages: { "@pnpm/plugin-better-defaults@0.3.0": {} },
});

test("a pnpm 11 lockfile, its config dependencies in a document of their own, is read document by document, caught by reading only single-document lockfiles", (t) => {
  const root = testRepo(t);
  put(root, "pnpm-lock.yaml", `---\n${CONFIG_DOCUMENT}---\n${TWO_CORES}`);
  assert.match(
    checkSingletonPackages(root),
    /^pnpm-lock\.yaml resolves "@antelopejs\/interface-core" at 2 versions/,
  );
  put(
    root,
    "pnpm-lock.yaml",
    `---\n${CONFIG_DOCUMENT}---\n${stringify({ lockfileVersion: "9.0", packages: { "@antelopejs/interface-core@0.2.6": {} } })}`,
  );
  assert.equal(checkSingletonPackages(root), "");
});

test("a version 5 lockfile fails as unreadable, a suffixed version string included, caught by a guard that lets a version Number cannot parse through", (t) => {
  const root = testRepo(t);
  for (const version of ["5.4", "5.4-inlineSpecifiers"]) {
    put(
      root,
      "pnpm-lock.yaml",
      stringify({
        lockfileVersion: version,
        packages: {
          "/@antelopejs/interface-core/0.1.1": {},
          "/@antelopejs/interface-core/0.2.6": {},
        },
      }),
    );
    assert.equal(
      checkSingletonPackages(root),
      "pnpm-lock.yaml: could not read it as a lockfile version this check knows.\n",
      version,
    );
  }
});

test("a copy an importer locks by tarball URL names that importer, caught by reading every version holding an @ as an npm: alias", (t) => {
  const root = testRepo(t);
  const tarball =
    "https://registry.npmjs.org/@antelopejs/interface-core/-/interface-core-0.2.6.tgz";
  put(
    root,
    "pnpm-lock.yaml",
    stringify({
      lockfileVersion: "9.0",
      importers: {
        ".": {
          dependencies: {
            "@antelopejs/interface-core": {
              specifier: tarball,
              version: tarball,
            },
          },
        },
      },
      packages: {
        "@antelopejs/interface-core@0.1.1": {},
        [`@antelopejs/interface-core@${tarball}`]: {},
      },
    }),
  );
  assert.match(
    checkSingletonPackages(root),
    new RegExp(
      `\\n {2}${tarball.replaceAll(".", "\\.")}, pulled by importer "\\."\\n`,
      "u",
    ),
  );
});
