import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { CI_PATH } from "./ci-workflow.ts";
import { fixture, jobsOf } from "./helpers/ci-text.ts";
import { bin, commit, put, read, testRepo } from "./helpers/test-repo.ts";
import { syncRepository } from "./sync.ts";

const SKILL = "formal-billing-lease";

function adoptedRepo(t: TestContext): string {
  const root = testRepo(t, false);
  assert.deepEqual(syncRepository(root).errors, []);
  commit(root);
  return root;
}

function addBillingRepo(root: string): void {
  put(root, `.agents/skills/${SKILL}/check.mjs`, "");
  put(
    root,
    `.agents/skills/${SKILL}/SKILL.md`,
    fixture("payment-subscriptions-formal-billing-lease.SKILL.md"),
  );
  for (const file of ["clock", "engine", "records", "transitions", "triggers"])
    put(root, `src/${file}.ts`, "");
  put(root, CI_PATH, fixture("payment-subscriptions-ci.yml"));
  commit(root);
}

test("sync --check reports Drift on the payment-subscriptions ci.yml, sync moves its formal job into formal-checks, and --check then passes", (t) => {
  const root = adoptedRepo(t);
  addBillingRepo(root);
  const drift = syncRepository(root, { check: true });
  assert.deepEqual(drift.errors, []);
  assert.ok(drift.paths.includes(CI_PATH), drift.paths.join(", "));
  const synced = syncRepository(root);
  assert.deepEqual(synced.errors, []);
  assert.ok(synced.paths.includes(CI_PATH));
  const text = read(root, CI_PATH);
  assert.deepEqual(Object.keys(jobsOf(text)), [
    "ci",
    "renovate-sync",
    "verdict",
  ]);
  assert.match(
    text,
    /formal-checks: \|\n {8}\[\n {10}\{"skill": "formal-billing-lease", "paths": \["src\/clock\.ts"/,
  );
  commit(root);
  assert.deepEqual(syncRepository(root, { check: true }).paths, []);
  assert.equal(bin(root, "sync", ["--check"]).status, 0);
});

test("a repository that drifts again is reported again, so a sync that records the formal move somewhere else fails", (t) => {
  const root = adoptedRepo(t);
  addBillingRepo(root);
  syncRepository(root);
  commit(root);
  put(root, CI_PATH, fixture("payment-subscriptions-ci.yml"));
  commit(root);
  const check = bin(root, "sync", ["--check"]);
  assert.equal(check.status, 1, check.stdout);
  assert.match(
    check.stdout,
    /Drift: \.github\/workflows\/ci\.yml; run antelopejs-sync/,
  );
});

test("an advisory reaches the CLI under sync and under --check and never fails either, so a sync that drops it or exits 1 on it fails", (t) => {
  const root = adoptedRepo(t);
  const text = `${read(root, CI_PATH)}  lint:\n    runs-on: [self-hosted, linux]\n    steps:\n      - run: pnpm lint\n`;
  put(root, CI_PATH, text);
  commit(root);
  const advisory =
    /Runner: \.github\/workflows\/ci\.yml job lint runs on \["self-hosted","linux"\], which sync cannot resolve to blacksmith-4vcpu-ubuntu-2404 or blacksmith-4vcpu-windows-2025\. Use a literal label\./;
  const check = bin(root, "sync", ["--check"]);
  assert.match(check.stdout, advisory);
  const sync = bin(root, "sync");
  assert.equal(sync.status, 0, sync.stderr);
  assert.match(sync.stdout, advisory);
  commit(root);
  const again = bin(root, "sync", ["--check"]);
  assert.equal(again.status, 0, again.stdout);
  assert.match(again.stdout, advisory);
});
