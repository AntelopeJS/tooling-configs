import assert from "node:assert/strict";
import test from "node:test";
import { parseDocument } from "yaml";

import { CI_CALLER, CI_NODE_REF, ciWorkflow } from "./ci-workflow.ts";
import { bin, commit, put, read, testRepo } from "./helpers/test-repo.ts";
import { ciNodeCallers, ciRenovateSyncCallers } from "./workflow.ts";

function rewrite(text: string): string {
  return ciWorkflow(text, ciNodeCallers(text), ciRenovateSyncCallers(text));
}

function jobIds(text: string): string[] {
  return Object.keys(parseDocument(text).toJS().jobs);
}

const AGGREGATOR = `  checks:
    if: always()
    needs: [ci]
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - if: contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') || contains(needs.*.result, 'skipped')
        run: exit 1
`;

const HEAD = `name: ci
on:
  push:
    branches:
      - main
      - next
  pull_request:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  ci:
    permissions:
      contents: read
    uses: ${CI_NODE_REF}
    with:
      renovate-sync: false
      test-job: true
  renovate-sync:
    if: >-
      github.event_name == 'pull_request' && startsWith(github.head_ref, 'renovate/') && github.event.pull_request.head.repo.full_name == github.repository
    permissions:
      contents: write
      actions: write
    uses: AntelopeJS/.github/.github/workflows/ci-renovate-sync.yml@v1
`;

const REDIS_CALLER = `${HEAD}${AGGREGATOR}`;

const E2E = `  e2e:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm run e2e
`;

test("the redis caller loses its checks job that only re-aggregates ci, so a rewrite that keeps it fails", () => {
  const synced = rewrite(REDIS_CALLER);
  assert.deepEqual(jobIds(synced), ["ci", "renovate-sync"]);
  assert.equal(synced, HEAD);
});

test("a caller on a job id other than ci is renamed first, so its checks job needing that id is still removed", () => {
  const before = `${HEAD.replace("  ci:\n", "  verify:\n")}${AGGREGATOR.replace("needs: [ci]", "needs: verify")}`;
  assert.deepEqual(jobIds(rewrite(before)), ["ci", "renovate-sync"]);
});

test("the same aggregator beside an e2e job is kept, so a rewrite that removes it on shape alone fails", () => {
  const gated = AGGREGATOR.replace("needs: [ci]", "needs: [ci, e2e]");
  for (const text of [`${HEAD}${E2E}${AGGREGATOR}`, `${HEAD}${E2E}${gated}`])
    assert.deepEqual(jobIds(rewrite(text)), [
      "ci",
      "renovate-sync",
      "e2e",
      "checks",
    ]);
  assert.equal(rewrite(`${HEAD}${E2E}${gated}`), `${HEAD}${E2E}${gated}`);
});

test("a checks job that runs real steps is kept, so a rewrite that removes any job named checks fails", () => {
  const real = `${HEAD}  checks:
    needs: [ci]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm run lint
`;
  const exitAfterWork = `${HEAD}  checks:
    needs: [ci]
    runs-on: ubuntu-latest
    steps:
      - run: pnpm run lint
      - if: needs.ci.result != 'success'
        run: exit 1
`;
  for (const text of [real, exitAfterWork])
    assert.deepEqual(jobIds(rewrite(text)), ["ci", "renovate-sync", "checks"]);
});

test("a checks job whose steps do not only exit on needs results is kept", () => {
  const variants = [
    AGGREGATOR.replace(
      "runs-on",
      "uses: other/repo/.github/workflows/x.yml@v1\n    runs-on",
    ),
    AGGREGATOR.replace(
      "run: exit 1",
      "run: exit 1\n      - uses: actions/checkout@v4",
    ),
    AGGREGATOR.replace(
      "run: exit 1",
      "run: curl https://example.com && exit 1",
    ),
    AGGREGATOR.replace(
      "contains(needs.*.result, 'failure') ||",
      "github.ref == 'refs/heads/main' ||",
    ),
    AGGREGATOR.replace(
      "    if: always()\n",
      "    if: github.event_name == 'push'\n",
    ),
    AGGREGATOR.replace(
      "      - if: contains",
      "      - run: exit 1\n      - if: contains",
    ),
    AGGREGATOR.replace("needs: [ci]", "needs: [ci, renovate-sync]"),
    AGGREGATOR.replace("    needs", "    name: legacy\n    needs"),
    AGGREGATOR.replace("    needs", "    env:\n      A: b\n    needs"),
  ];
  for (const variant of variants)
    assert.ok(jobIds(rewrite(`${HEAD}${variant}`)).includes("checks"), variant);
});

test("a workflow whose jobs besides ci, the sync caller and checks include a second ci-node caller keeps checks", () => {
  const second = `  second:
    uses: ${CI_NODE_REF}
    with:
      renovate-sync: false
`;
  assert.ok(
    jobIds(rewrite(`${HEAD}${second}${AGGREGATOR}`)).includes("checks"),
  );
});

test("the canonical caller is unchanged", () => {
  assert.equal(rewrite(CI_CALLER), CI_CALLER);
});

test("a workflow with no ci-node caller keeps its checks job", () => {
  const own = `name: ci
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm test
${AGGREGATOR.replace("needs: [ci]", "needs: [build]")}`;
  assert.equal(rewrite(own), own);
});

test("the sync caller still needing the removed checks fails with a message that says it was removed, not renamed", () => {
  const dependent = REDIS_CALLER.replace(
    "  renovate-sync:\n",
    "  renovate-sync:\n    needs: checks\n",
  );
  assert.throws(
    () => rewrite(dependent),
    /job renovate-sync needs checks, but sync removes the job checks because it only re-aggregates ci.*Replace checks with ci in the needs: of renovate-sync/,
  );
});

test("sync --check reports a repo still carrying the redundant checks job, and sync then removes it and --check passes", (t) => {
  const root = testRepo(t, false);
  put(
    root,
    "guardrails.ratchet.json",
    '{"rules":{"eslint/no-alert":1},"oversizeFiles":{}}\n',
  );
  assert.equal(bin(root, "sync").status, 0);
  put(root, ".github/workflows/ci.yml", REDIS_CALLER);
  commit(root);
  const check = bin(root, "sync", ["--check"]);
  assert.equal(check.status, 1, check.stdout);
  assert.match(`${check.stdout}${check.stderr}`, /ci\.yml/);
  assert.equal(bin(root, "sync").status, 0);
  assert.equal(read(root, ".github/workflows/ci.yml"), HEAD);
  commit(root);
  assert.equal(bin(root, "sync", ["--check"]).status, 0);
});
