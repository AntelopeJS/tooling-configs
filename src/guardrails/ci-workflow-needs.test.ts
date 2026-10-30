import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { parseDocument } from "yaml";

import {
  CI_CALLER,
  CI_NODE_REF,
  CI_RENOVATE_SYNC_REF,
  ciWorkflow,
} from "./ci-workflow.ts";
import {
  PACKAGE_ROOT,
  bin,
  commit,
  put,
  read,
  testRepo,
} from "./helpers/test-repo.ts";
import { ciNodeCallers, ciRenovateSyncCallers } from "./workflow.ts";

const DMS_545_STALE_GATE = read(
  PACKAGE_ROOT,
  "src/guardrails/fixtures/dms-545-d5638a92-stale-gate-needs.txt",
);

function rewrite(text: string): string {
  return ciWorkflow(text, ciNodeCallers(text), ciRenovateSyncCallers(text));
}

function adoptedRepo(t: TestContext): string {
  const root = testRepo(t, false);
  put(
    root,
    "guardrails.ratchet.json",
    '{"rules":{"eslint/no-alert":1},"oversizeFiles":{}}\n',
  );
  const sync = bin(root, "sync");
  assert.equal(sync.status, 0, sync.stderr);
  commit(root);
  return root;
}

const DMS_22ED5906_GATE = `name: ci
on:
  push:
    branches:
      - main
  pull_request:
permissions:
  contents: read
jobs:
  checks:
    uses: ${CI_NODE_REF}
    with:
      docs-files: README.md
  backend:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm --dir packages/dms test
  ubuntu:
    if: always()
    needs:
      [
        checks,
        backend,
      ]
    runs-on: ubuntu-latest
    steps:
      - if: >-
          contains(needs.*.result, 'failure') ||
          needs.checks.result == 'skipped' ||
          needs.backend.result == 'skipped'
        run: exit 1
`;

const EXTRA_JOBS = `name: ci
on: [push, pull_request, workflow_dispatch]
permissions:
  contents: read
jobs:
  ci:
    permissions:
      contents: read
    uses: ${CI_NODE_REF}
    with:
      renovate-sync: false
  renovate-sync:
    permissions:
      contents: write
      actions: write
    uses: ${CI_RENOVATE_SYNC_REF}
  formal:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        check: [a, b]
    steps:
      - run: node check.mjs \${{ matrix.check }}
  deploy:
    needs: formal
    if: needs.formal.result == 'success'
    runs-on: ubuntu-latest
    env:
      FORMAL: \${{ needs['formal'].outputs.report }}
    steps:
      - run: echo "needs.missing is plain text"
  ubuntu:
    if: always()
    needs: [ci, formal, deploy]
    runs-on: ubuntu-latest
    steps:
      - if: contains(needs.*.result, 'failure') || needs.ci.result == 'skipped' || needs.deploy.result == 'skipped'
        run: exit 1
`;

test("sync --check fails the dms #545 caller (d5638a92) whose ubuntu gate still reads needs.checks after the rename to ci, and names the fix", (t) => {
  const root = adoptedRepo(t);
  put(root, ".github/workflows/ci.yml", DMS_545_STALE_GATE);
  commit(root);
  const check = bin(root, "sync", ["--check"]);
  assert.equal(check.status, 1, check.stdout);
  assert.match(
    `${check.stdout}${check.stderr}`,
    /job ubuntu reads needs\.checks, but checks is not in its needs: \[ci, backend, docs-playground\]/,
  );
  assert.match(`${check.stdout}${check.stderr}`, /needs\.ci/);
});

test("sync refuses to keep the dms #545 stale gate instead of writing it back", (t) => {
  const root = adoptedRepo(t);
  put(root, ".github/workflows/ci.yml", DMS_545_STALE_GATE);
  commit(root);
  assert.equal(bin(root, "sync").status, 1);
  assert.equal(read(root, ".github/workflows/ci.yml"), DMS_545_STALE_GATE);
});

test("a needs list entry naming a job that does not exist fails the caller and names the job", () => {
  const stale = EXTRA_JOBS.replace(
    "needs: [ci, formal, deploy]",
    "needs: [checks, formal, deploy]",
  );
  assert.throws(
    () => rewrite(stale),
    /job ubuntu needs checks, but no job checks exists/,
  );
});

test("the dms 22ed5906 gate on checks is renamed to ci with its needs.checks references, and sync --check then passes", (t) => {
  const root = adoptedRepo(t);
  put(root, ".github/workflows/ci.yml", DMS_22ED5906_GATE);
  commit(root);
  assert.equal(bin(root, "sync", ["--check"]).status, 1);
  const sync = bin(root, "sync");
  assert.equal(sync.status, 0, sync.stdout);
  const synced = read(root, ".github/workflows/ci.yml");
  assert.match(synced, /needs\.ci\.result == 'skipped'/);
  assert.doesNotMatch(synced, /needs\.checks/);
  assert.deepEqual(parseDocument(synced).toJS().jobs.ubuntu.needs, [
    "ci",
    "backend",
  ]);
  commit(root);
  assert.equal(bin(root, "sync", ["--check"]).status, 0);
});

test("the canonical caller and a caller with repository-specific gate jobs pass unchanged", () => {
  assert.equal(rewrite(CI_CALLER), CI_CALLER);
  assert.equal(rewrite(EXTRA_JOBS), EXTRA_JOBS);
});

test("sync --check passes a caller with repository-specific gate jobs", (t) => {
  const root = adoptedRepo(t);
  put(root, ".github/workflows/ci.yml", EXTRA_JOBS);
  commit(root);
  const check = bin(root, "sync", ["--check"]);
  assert.equal(check.status, 0, check.stdout);
});
