import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { formatCeilings, readCeilings, type Ceilings } from "./ceilings.ts";
import {
  bin,
  commit,
  linkOxlint,
  put,
  read,
  testRepo,
} from "./helpers/test-repo.ts";

const TSGOLINT = fileURLToPath(
  new URL(
    "bin/tsgolint.js",
    import.meta.resolve("oxlint-tsgolint/package.json"),
  ),
);

const ENV = { OXLINT_TSGOLINT_PATH: TSGOLINT };

/** Reduced from mollie@60405ad under the #69 head pack: two `any` values assigned to typed bindings and one returned as a typed result. */
const MOLLIE_FINDINGS = `export function metadata(text: string): Record<string, string> {
  const parsed: Record<string, string> = JSON.parse(text);
  return parsed;
}

export function standIn(text: string): string[] {
  const deliveries: string[] = JSON.parse(text);
  return deliveries;
}

export function parseBody(text: string): Record<string, string> {
  return JSON.parse(text);
}
`;

const UNSAFE_ASSIGNMENT = "typescript/no-unsafe-assignment";
const UNSAFE_RETURN = "typescript/no-unsafe-return";

/** A repository on the pack release before #69, its ratchet recording that release, with the #69 rules now reporting its legacy findings. */
function upgradedRepo(t: TestContext, ceilings?: Ceilings): string {
  const root = testRepo(t);
  linkOxlint(root);
  put(
    root,
    ".oxlintrc.json",
    JSON.stringify({
      options: { typeAware: true },
      categories: { correctness: "off" },
      plugins: ["eslint", "typescript"],
      rules: {
        [UNSAFE_ASSIGNMENT]: "error",
        [UNSAFE_RETURN]: "error",
        "eslint/max-params": ["error", { max: 1 }],
      },
    }),
  );
  put(
    root,
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { strict: true, target: "es2022", module: "nodenext" },
      include: ["src"],
    }),
  );
  put(root, "src/mollie.ts", MOLLIE_FINDINGS);
  if (ceilings) put(root, "guardrails.ratchet.json", formatCeilings(ceilings));
  commit(root);
  return root;
}

function ratchet(root: string, ...args: string[]) {
  return bin(root, "ratchet", args, ENV);
}

test("#69 upgrade: ratchet --update records the counts of the rules the pack enabled after the recorded release, once", (t) => {
  const root = upgradedRepo(t, {
    pack: "0.2.16",
    rules: { "eslint/max-params": 0 },
    oversizeFiles: {},
  });
  const update = ratchet(root, "--update");
  assert.deepEqual(readCeilings(root), {
    pack: "0.2.17",
    rules: { [UNSAFE_ASSIGNMENT]: 2, [UNSAFE_RETURN]: 1 },
    oversizeFiles: {},
  });
  assert.equal(update.status, 0, update.stderr);
  assert.match(
    update.stdout,
    /Adopted typescript\/no-unsafe-assignment: 2, enabled by the pack in 0\.2\.17\./,
  );
  const recorded = read(root, "guardrails.ratchet.json");
  assert.match(recorded, /^\{\n {2}"pack": "0\.2\.17",\n {2}"rules": \{/);
  const again = ratchet(root, "--update");
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /Adopted/);
  assert.equal(read(root, "guardrails.ratchet.json"), recorded);
  assert.equal(ratchet(root).status, 0);
});

test("before the update, the full ratchet names ratchet:update for a pack-new rule only", (t) => {
  const root = upgradedRepo(t, {
    pack: "0.2.16",
    rules: { "eslint/max-params": 0 },
    oversizeFiles: {},
  });
  put(
    root,
    "src/pair.ts",
    "export function pair(a: string, b: string): string { return a + b; }\n",
  );
  const before = ratchet(root);
  assert.equal(before.status, 1);
  assert.match(
    before.stderr,
    /typescript\/no-unsafe-assignment: 2 diagnostics exceeds ceiling 0\. The pack enabled this rule in 0\.2\.17, after this repository's 0\.2\.16; run ratchet:update to record today's count\./,
  );
  assert.match(
    before.stderr,
    /eslint\/max-params: 1 diagnostics exceeds ceiling 0\.\n/,
  );
});

test("a pre-existing rule with a ceiling of 0 that regresses is not adopted", (t) => {
  const root = upgradedRepo(t, {
    pack: "0.2.16",
    rules: { "eslint/max-params": 0 },
    oversizeFiles: {},
  });
  put(
    root,
    "src/pair.ts",
    "export function pair(a: string, b: string): string { return a + b; }\n",
  );
  const update = ratchet(root, "--update");
  assert.equal(update.status, 1);
  assert.match(
    update.stderr,
    /eslint\/max-params: 1 diagnostics exceeds ceiling 0\.\n {2}src\/pair\.ts:1:\d+:/,
  );
  assert.doesNotMatch(update.stdout, /Adopted eslint/);
  assert.equal(readCeilings(root).rules["eslint/max-params"], 0);
});

test("a pack-new rule fixed to 0 and later regressed is not adopted again, because the recorded release moved forward", (t) => {
  const root = upgradedRepo(t, {
    pack: "0.2.16",
    rules: {},
    oversizeFiles: {},
  });
  assert.equal(ratchet(root, "--update").status, 0);
  put(
    root,
    "src/mollie.ts",
    "export function parseBody(text: string): Record<string, string> {\n  return JSON.parse(text);\n}\n",
  );
  assert.equal(ratchet(root, "--update").status, 0);
  assert.deepEqual(readCeilings(root), {
    pack: "0.2.17",
    rules: { [UNSAFE_RETURN]: 1 },
    oversizeFiles: {},
  });
  put(root, "src/regressed.ts", MOLLIE_FINDINGS);
  const regressed = ratchet(root, "--update");
  assert.equal(regressed.status, 1);
  assert.match(
    regressed.stderr,
    /typescript\/no-unsafe-assignment: 2 diagnostics exceeds ceiling 0\.\n/,
  );
  assert.doesNotMatch(regressed.stderr, /run ratchet:update/);
  assert.deepEqual(readCeilings(root).rules, { [UNSAFE_RETURN]: 1 });
});

test("after adoption the full ratchet and the staged hook fail a finding a change adds", (t) => {
  const root = upgradedRepo(t, {
    pack: "0.2.16",
    rules: {},
    oversizeFiles: {},
  });
  assert.equal(ratchet(root, "--update").status, 0);
  commit(root);
  put(
    root,
    "src/added.ts",
    "export function added(text: string): string[] {\n  const rows: string[] = JSON.parse(text);\n  return rows;\n}\n",
  );
  const full = ratchet(root);
  assert.equal(full.status, 1);
  assert.match(
    full.stderr,
    /typescript\/no-unsafe-assignment: 3 diagnostics exceeds ceiling 2\.\n {2}src\/added\.ts:2:\d+:/,
  );
  execFileSync("git", ["add", "src/added.ts"], { cwd: root });
  const staged = ratchet(root, "--staged");
  assert.equal(staged.status, 1);
  assert.match(
    staged.stderr,
    /typescript\/no-unsafe-assignment: this commit adds 1 to the staged files/,
  );
});

test("a ratchet file without a recorded release predates the registry, and the update records one", (t) => {
  const root = upgradedRepo(t, { rules: {}, oversizeFiles: {} });
  assert.equal(ratchet(root, "--update").status, 0);
  assert.deepEqual(readCeilings(root), {
    pack: "0.2.17",
    rules: { [UNSAFE_ASSIGNMENT]: 2, [UNSAFE_RETURN]: 1 },
    oversizeFiles: {},
  });
});

test("a clean repository gets a ratchet file holding only the pack-new rules, and is told to run sync for the hook", (t) => {
  const root = upgradedRepo(t);
  put(
    root,
    "src/pair.ts",
    "export function pair(a: string, b: string): string { return a + b; }\n",
  );
  const update = ratchet(root, "--update");
  assert.equal(update.status, 1);
  assert.match(update.stderr, /eslint\/max-params: 1 diagnostics exceeds/);
  assert.match(
    update.stdout,
    /Created guardrails\.ratchet\.json for the rules the pack newly enabled\. Run antelopejs-sync\./,
  );
  assert.deepEqual(readCeilings(root), {
    pack: "0.2.17",
    rules: { [UNSAFE_ASSIGNMENT]: 2, [UNSAFE_RETURN]: 1 },
    oversizeFiles: {},
  });
});

test("a clean repository whose committed lockfile already installs the release that enabled the rules adopts nothing", (t) => {
  const root = upgradedRepo(t);
  put(root, "pnpm-lock.yaml", lockfile("0.2.17"));
  commit(root);
  const update = ratchet(root, "--update");
  assert.equal(update.status, 1);
  assert.match(
    update.stderr,
    /typescript\/no-unsafe-assignment: 2 diagnostics exceeds ceiling 0\.\n/,
  );
  assert.equal(existsSync(join(root, "guardrails.ratchet.json")), false);
  put(root, "pnpm-lock.yaml", lockfile("0.2.16"));
  commit(root);
  assert.equal(ratchet(root, "--update").status, 0);
  assert.equal(readCeilings(root).rules[UNSAFE_ASSIGNMENT], 2);
});

function lockfile(version: string): string {
  return `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    devDependencies:\n      '@antelopejs/tooling-configs':\n        specifier: ^${version}\n        version: ${version}(oxlint@1.81.0)\n      oxlint:\n        specifier: 1.81.0\n        version: 1.81.0\n`;
}

test("against the pull request base, a hand-added or raised ceiling fails and a pack-new adoption passes", (t) => {
  const root = upgradedRepo(t, {
    pack: "0.2.16",
    rules: { "eslint/max-params": 1 },
    oversizeFiles: {},
  });
  put(
    root,
    "src/pair.ts",
    "export function pair(a: string, b: string): string { return a + b; }\nexport function three(a: string, b: string): string { return a + b; }\n",
  );
  assert.equal(ratchet(root, "--update", "--base", "HEAD").status, 1);
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({
      ...readCeilings(root),
      rules: { ...readCeilings(root).rules, "eslint/max-params": 2 },
    }),
  );
  const raised = ratchet(root, "--base", "HEAD");
  assert.equal(raised.status, 1);
  assert.match(
    raised.stderr,
    /guardrails\.ratchet\.json: raises eslint\/max-params from 1 on the base to 2\./,
  );
  assert.doesNotMatch(raised.stderr, /no-unsafe-assignment/);
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({
      pack: "0.2.17",
      rules: {
        "eslint/max-params": 1,
        "eslint/no-alert": 4,
        [UNSAFE_ASSIGNMENT]: 3,
        [UNSAFE_RETURN]: 1,
      },
      oversizeFiles: { "src/mollie.ts": 900 },
    }),
  );
  const added = ratchet(root, "--base", "HEAD");
  assert.equal(added.status, 1);
  assert.match(
    added.stderr,
    /guardrails\.ratchet\.json: adds eslint\/no-alert, which the pack did not newly enable\./,
  );
  assert.match(
    added.stderr,
    /guardrails\.ratchet\.json: adds typescript\/no-unsafe-assignment at 3, above its 2 findings\./,
  );
  assert.match(
    added.stderr,
    /guardrails\.ratchet\.json: adds an oversize allowance for src\/mollie\.ts\./,
  );
  assert.doesNotMatch(added.stderr, /no-unsafe-return/);
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({ rules: { "eslint/max-params": 1 }, oversizeFiles: {} }),
  );
  assert.match(
    ratchet(root, "--base", "HEAD").stderr,
    /guardrails\.ratchet\.json: drops the recorded pack release 0\.2\.16 the base has\./,
  );
});
