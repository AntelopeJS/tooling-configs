import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { bin, put, testRepo } from "./helpers/test-repo.ts";
import { KNOWN_FAILURES_FILE, readKnownFailures } from "./known-failures.ts";
import { shimInvocation } from "./run-command.ts";

const OTHER_STEPS =
  "typecheck,lint,format:check,knip,test,size,suppressions,sync:check,git:identity,lockfile:singletons";

const BROKEN = "export declare const value: Missing;\n";
const SOUND = "export declare const value: number;\n";

/** A tarball of the third-party package `vendor-types` whose `index.d.ts` is `declaration`. */
function vendorTarball(t: TestContext, declaration: string): string {
  const directory = mkdtempSync(join(tmpdir(), "published-types-vendor-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  put(
    directory,
    "package.json",
    JSON.stringify({
      name: "vendor-types",
      version: "1.0.0",
      types: "index.d.ts",
    }),
  );
  put(directory, "index.d.ts", declaration);
  const pack = shimInvocation("npm", [
    "pack",
    "--silent",
    "--pack-destination",
    directory,
  ]);
  const file = execFileSync(pack.command, pack.args, {
    cwd: directory,
    encoding: "utf8",
    shell: pack.shell,
  }).trim();
  return join(directory, file).replaceAll("\\", "/");
}

/** A typed package that re-exports `vendor-types`, with `own` as its own declaration and `entries` as its known failures. */
function checksOf(t: TestContext, vendor: string, entries: object[], own = "") {
  const root = testRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({
      name: "@fixture/typed",
      version: "1.0.0",
      packageManager: "pnpm@10.2.0",
      types: "index.d.ts",
      peerDependencies: { "vendor-types": `file:${vendor}` },
    }),
  );
  put(root, "index.d.ts", `export { value } from "vendor-types";\n${own}`);
  put(root, KNOWN_FAILURES_FILE, JSON.stringify({ knownFailures: entries }));
  return bin(root, "checks", ["--no-services"], {
    ANTELOPEJS_CHECKS_SKIP: OTHER_STEPS,
  });
}

const VENDOR_ENTRY = {
  dependency: "vendor-types",
  file: "index.d.ts",
  code: "TS2304",
};

test("a declared error in a dependency's declarations passes checks and is printed as known, caught by an implementation that fails it or passes it silently", (t) => {
  const result = checksOf(t, vendorTarball(t, BROKEN), [VENDOR_ENTRY]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /^\[published:types\]\npackage\.json: @fixture\/typed as a consumer installs it, checked by tsc with skipLibCheck off, errors guardrails\.published-types\.json declares as known:\nvendor-types\/index\.d\.ts\(1,\d+\): error TS2304: Cannot find name 'Missing'\.\n/,
  );
  assert.match(result.stdout, /Checks: 1 passed, 0 failed, 9 skipped\.\n$/);
});

test("a declared error that no longer occurs fails checks and names the entry to remove, caught by an implementation that lets a stale entry pass", (t) => {
  const result = checksOf(t, vendorTarball(t, SOUND), [VENDOR_ENTRY]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /^\[published:types\]\nguardrails\.published-types\.json: vendor-types\/index\.d\.ts TS2304 no longer occurs\. Remove the entry\.\n/,
  );
});

test("an error in the package's own declarations fails checks even when an entry names the package, caught by an implementation that matches an entry against any package", (t) => {
  const result = checksOf(
    t,
    vendorTarball(t, SOUND),
    [{ dependency: "@fixture/typed", file: "index.d.ts", code: "TS2304" }],
    "export declare const own: Missing;\n",
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /@fixture\/typed\/index\.d\.ts\(2,\d+\): error TS2304: Cannot find name 'Missing'\./,
  );
  assert.doesNotMatch(result.stdout, /declares as known/);
});

test("an error in a dependency's file no entry names fails checks, caught by an implementation that matches an entry by dependency or code alone", (t) => {
  const result = checksOf(t, vendorTarball(t, BROKEN), [
    { ...VENDOR_ENTRY, file: "other.d.ts" },
    { ...VENDOR_ENTRY, dependency: "other-types" },
  ]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /checked by tsc with skipLibCheck off:\nvendor-types\/index\.d\.ts\(1,\d+\): error TS2304: Cannot find name 'Missing'\./,
  );
  assert.doesNotMatch(result.stdout, /declares as known/);
});

test("readKnownFailures names each malformed entry, caught by an implementation that accepts an entry missing a field or with a code tsc never prints", (t) => {
  const root = testRepo(t);
  put(
    root,
    KNOWN_FAILURES_FILE,
    JSON.stringify({
      knownFailures: [
        VENDOR_ENTRY,
        { dependency: "vendor-types", code: "TS2304" },
        { ...VENDOR_ENTRY, code: "2304" },
        { ...VENDOR_ENTRY, file: "../index.d.ts" },
        { ...VENDOR_ENTRY, line: 1 },
      ],
    }),
  );
  assert.deepEqual(readKnownFailures(root), {
    failure: [
      "knownFailures[1] needs file as a path inside the package.",
      "knownFailures[2] needs code such as TS2416.",
      "knownFailures[3] needs file as a path inside the package.",
      "knownFailures[4] has unknown key line.",
    ]
      .map((line) => `${KNOWN_FAILURES_FILE}: ${line}\n`)
      .join(""),
  });
});
