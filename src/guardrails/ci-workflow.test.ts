import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { parseDocument } from "yaml";

import {
  CI_CALLER,
  CI_CONTEXT,
  CI_NODE_REF,
  CI_RENOVATE_SYNC_REF,
  ciWorkflow,
  mutationCaller,
} from "./ci-workflow.ts";
import { MANAGED_ARTIFACTS, syncRepository } from "./sync.ts";
import {
  PACKAGE_ROOT,
  bin,
  commit,
  put,
  read,
  testRepo,
} from "./helpers/test-repo.ts";
import { ciNodeCallers, ciRenovateSyncCallers } from "./workflow.ts";

function rewrite(text: string): string {
  return ciWorkflow(text, ciNodeCallers(text), ciRenovateSyncCallers(text));
}

interface JobView {
  permissions?: Record<string, string>;
  with?: Record<string, string | boolean>;
  uses?: string;
  if?: string;
  needs?: string | string[];
  "runs-on"?: string;
  steps?: string[];
}

function jobs(text: string): Record<string, JobView> {
  return parseDocument(text).toJS().jobs;
}

const WRITE_GRANTED_CALLER = `name: ci
on:
  push:
    branches:
      - main
  pull_request:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  ci:
    permissions:
      contents: write
      actions: write
    uses: ${CI_NODE_REF}
`;

const LEGACY = `name: ci
on:
  push:
    branches: [main]
jobs:
  checks:
    name: Checks
    uses: ${CI_NODE_REF}
    with:
      docs-files: README.md
  deploy:
    needs: [checks]
    runs-on: ubuntu-latest
    steps:
      - run: echo done
  notify:
    needs: checks
    runs-on: ubuntu-latest
    steps:
      - run: echo done
`;

test("the default caller reports the context ci / checks, because its job id is ci and it has no name", () => {
  const [caller] = ciNodeCallers(CI_CALLER);
  assert.deepEqual(caller, { id: "ci", uses: CI_NODE_REF, named: false });
  assert.equal(CI_CONTEXT, "ci / checks");
});

test("a caller under another id is renamed to ci, loses its name, keeps its inputs and drags its dependents along", () => {
  const rewritten = rewrite(LEGACY);
  assert.deepEqual(ciNodeCallers(rewritten), [
    { id: "ci", uses: CI_NODE_REF, named: false },
  ]);
  assert.match(rewritten, /docs-files: README\.md/);
  assert.deepEqual(jobs(rewritten).deploy.needs, ["ci"]);
  assert.equal(jobs(rewritten).notify.needs, "ci");
  assert.equal(rewrite(rewritten), rewritten);
});

const DMS_AGGREGATE = `name: ci
on:
  push:
    branches: [main]
jobs:
  checks:
    uses: ${CI_NODE_REF}
  ubuntu:
    needs: [checks, other]
    if: always() && needs.checks.result == 'skipped'
    runs-on: ubuntu-latest
    env:
      CI_RESULT: \${{ needs['checks'].result }}
      KEPT: \${{ needs.checks-extra.result }}
    steps:
      - if: needs.checks.result == 'skipped' || needs.other.result == 'failure'
        run: echo "needs.checks stays in plain text"
      - run: echo \${{ needs.checks.result }}
  other:
    runs-on: ubuntu-latest
    steps: []
`;

test("renaming the caller to ci also rewrites needs.<old-id> in if, env and run expressions and leaves other ids and plain text alone", () => {
  const rewritten = rewrite(DMS_AGGREGATE);
  const aggregate = jobs(rewritten).ubuntu;
  assert.equal(aggregate.if, "always() && needs.ci.result == 'skipped'");
  assert.match(rewritten, /CI_RESULT: \$\{\{ needs\['ci'\]\.result \}\}/);
  assert.match(rewritten, /KEPT: \$\{\{ needs\.checks-extra\.result \}\}/);
  assert.match(
    rewritten,
    /- if: needs\.ci\.result == 'skipped' \|\| needs\.other\.result == 'failure'/,
  );
  assert.match(rewritten, /echo "needs\.checks stays in plain text"/);
  assert.match(rewritten, /echo \$\{\{ needs\.ci\.result \}\}/);
  assert.equal(rewrite(rewritten), rewritten);
});

test("a conformant caller is returned byte for byte, comments and extra jobs included", () => {
  const text = `# keep me\nname: ci\non: [push, workflow_dispatch]\njobs:\n  ci:\n    permissions:\n      contents: read\n    uses: ${CI_NODE_REF}\n    with:\n      renovate-sync: false\n      docs-files: README.md # docs\n  renovate-sync:\n    permissions:\n      contents: write\n      actions: write\n    uses: ${CI_RENOVATE_SYNC_REF}\n  deploy:\n    needs: ci\n    runs-on: ubuntu-latest\n    steps: []\n`;
  assert.equal(rewrite(text), text);
  assert.equal(rewrite(CI_CALLER), CI_CALLER);
});

test("the canonical caller keeps the job ci read-only and gives only the renovate-sync job the write grants", () => {
  const parsed = jobs(CI_CALLER);
  assert.deepEqual(parsed.ci.permissions, { contents: "read" });
  assert.deepEqual(parsed.ci.with, { "renovate-sync": false });
  assert.deepEqual(parsed["renovate-sync"].permissions, {
    contents: "write",
    actions: "write",
  });
  assert.equal(parsed["renovate-sync"].uses, CI_RENOVATE_SYNC_REF);
  assert.deepEqual(ciRenovateSyncCallers(CI_CALLER), [
    { id: "renovate-sync", uses: CI_RENOVATE_SYNC_REF, named: false },
  ]);
});

test("an old-shape caller with write grants is rewritten to the new shape and the rewrite is idempotent", () => {
  const rewritten = rewrite(WRITE_GRANTED_CALLER);
  const parsed = jobs(rewritten);
  assert.deepEqual(parsed.ci.permissions, { contents: "read" });
  assert.deepEqual(parsed.ci.with, { "renovate-sync": false });
  assert.equal(parsed.ci.uses, CI_NODE_REF);
  assert.deepEqual(parsed["renovate-sync"], jobs(CI_CALLER)["renovate-sync"]);
  assert.equal(rewrite(rewritten), rewritten);
});

test("rewriting keeps the other inputs, comments, other jobs and the pinned refs of the callers", () => {
  const branch = "AntelopeJS/.github/.github/workflows/ci-node.yml@fix/branch";
  const text = `# keep me\nname: ci\non: [push, workflow_dispatch]\njobs:\n  ci:\n    uses: ${branch} # pinned\n    with:\n      docs-files: README.md\n      renovate-sync: true\n  deploy:\n    needs: ci\n    runs-on: ubuntu-latest\n    steps: []\n`;
  const rewritten = rewrite(text);
  const parsed = jobs(rewritten);
  assert.equal(parsed.ci.uses, branch);
  assert.deepEqual(parsed.ci.with, {
    "docs-files": "README.md",
    "renovate-sync": false,
  });
  assert.deepEqual(parsed.ci.permissions, { contents: "read" });
  assert.deepEqual(parsed.deploy, {
    needs: "ci",
    "runs-on": "ubuntu-latest",
    steps: [],
  });
  assert.match(rewritten, /^# keep me\n/);
  assert.match(rewritten, /# pinned/);
  assert.equal(rewrite(rewritten), rewritten);
});

test("an existing renovate-sync caller keeps its ref, id and condition and only has its grants set", () => {
  const ref =
    "AntelopeJS/.github/.github/workflows/ci-renovate-sync.yml@fix/branch";
  const text = `name: ci\non: [workflow_dispatch]\njobs:\n  ci:\n    permissions:\n      contents: read\n    uses: ${CI_NODE_REF}\n    with:\n      renovate-sync: false\n  sync:\n    if: github.event_name == 'pull_request'\n    permissions: write-all\n    uses: ${ref}\n`;
  const parsed = jobs(rewrite(text));
  assert.deepEqual(Object.keys(parsed), ["ci", "sync"]);
  assert.equal(parsed.sync.uses, ref);
  assert.equal(parsed.sync.if, "github.event_name == 'pull_request'");
  assert.deepEqual(parsed.sync.permissions, {
    contents: "write",
    actions: "write",
  });
});

test("a renovate-sync job that does not call ci-renovate-sync.yml blocks the sync instead of being overwritten", () => {
  const clash = `on: workflow_dispatch\njobs:\n  ci:\n    uses: ${CI_NODE_REF}\n  renovate-sync:\n    runs-on: ubuntu-latest\n    steps: []\n`;
  assert.throws(
    () => rewrite(clash),
    /a job named renovate-sync already exists/,
  );
});

test("a ci-node.yml caller that itself uses the id renovate-sync gets its own error, not the one about a foreign job", () => {
  const text = `on: workflow_dispatch\njobs:\n  renovate-sync:\n    uses: ${CI_NODE_REF}\n`;
  assert.throws(
    () => rewrite(text),
    /the job renovate-sync calls ci-node\.yml, but that id is reserved/,
  );
});

test("a rewritten caller passes the pack's own formatter check, whether old-shape, renamed with flow needs, or with a long flow list", (t) => {
  const root = testRepo(t, false);
  const long =
    "[checks, backend, frontend-test, frontend-verify, docs-playground, verify-map, formal]";
  const cases = {
    old: WRITE_GRANTED_CALLER,
    renamed: `name: ci\non: { push: { branches: [main] }, pull_request: {} }\njobs:\n  checks:\n    name: Checks\n    uses: ${CI_NODE_REF}\n    with: { docs-files: README.md }\n  deploy:\n    needs: [checks]\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo done\n  notify:\n    needs: ${long}\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo done\n`,
  };
  for (const [name, text] of Object.entries(cases)) {
    const rewritten = rewrite(text);
    assert.notEqual(rewritten, text, name);
    put(root, `${name}.yml`, rewritten);
    const check = spawnSync(
      join(PACKAGE_ROOT, "node_modules/.bin/oxfmt"),
      ["-c", join(PACKAGE_ROOT, "oxfmt.config.ts"), "--check", `${name}.yml`],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(check.status, 0, `${name}: ${check.stdout}${check.stderr}`);
    assert.equal(rewrite(rewritten), rewritten, name);
  }
});

test("a renamed caller still gets a renovate-sync job and keeps its dependents", () => {
  const parsed = jobs(rewrite(LEGACY));
  assert.deepEqual(Object.keys(parsed), [
    "ci",
    "deploy",
    "notify",
    "renovate-sync",
  ]);
  assert.deepEqual(parsed.ci.with, {
    "docs-files": "README.md",
    "renovate-sync": false,
  });
});

test("an inline CI without a caller job is left alone, not replaced", () => {
  const inline =
    "name: ci\njobs:\n  checks:\n    steps:\n      - run: pnpm run checks\n";
  assert.equal(rewrite(inline), inline);
});

test("another job already named ci blocks the rename instead of overwriting it", () => {
  const clash = `jobs:\n  checks:\n    uses: ${CI_NODE_REF}\n  ci:\n    runs-on: ubuntu-latest\n    steps: []\n`;
  assert.throws(() => rewrite(clash), /a job named ci already exists/);
});

test("the weekly mutation caller targets mutation.yml@v1 and each package gets a stable slot in the week", () => {
  const text = mutationCaller("@antelopejs/mongodb");
  assert.match(
    text,
    /uses: AntelopeJS\/\.github\/\.github\/workflows\/mutation\.yml@v1/,
  );
  assert.match(text, /cron: "\d+ \d+ \* \* [0-6]"/);
  assert.equal(mutationCaller("@antelopejs/mongodb"), text);
  assert.notEqual(mutationCaller("@antelopejs/redis"), text);
});

test("sync writes both callers into a repository without them, and sync --check reports a drifted caller job id", (t) => {
  const root = testRepo(t, false);
  put(
    root,
    "guardrails.ratchet.json",
    '{"rules":{"eslint/no-alert":1},"oversizeFiles":{}}\n',
  );
  const first = bin(root, "sync");
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(
    ciNodeCallers(read(root, ".github/workflows/ci.yml")).map(({ id }) => id),
    ["ci"],
  );
  assert.match(
    read(root, ".github/workflows/mutation.yml"),
    /mutation\.yml@v1/,
  );
  assert.equal(bin(root, "sync", ["--check"]).status, 0);
  put(root, ".github/workflows/ci.yml", LEGACY);
  commit(root);
  const drift = bin(root, "sync", ["--check"]);
  assert.equal(drift.status, 1);
  assert.match(drift.stdout, /Drift: \.github\/workflows\/ci\.yml/);
  assert.equal(bin(root, "sync").status, 0);
  assert.equal(bin(root, "sync", ["--check"]).status, 0);
});

test("sync --check reports an old-shape ci.yml with write grants as drift, sync rewrites it and the new shape is clean", (t) => {
  const root = testRepo(t, false);
  put(
    root,
    "guardrails.ratchet.json",
    '{"rules":{"eslint/no-alert":1},"oversizeFiles":{}}\n',
  );
  assert.equal(bin(root, "sync").status, 0);
  put(root, ".github/workflows/ci.yml", WRITE_GRANTED_CALLER);
  commit(root);
  const drift = bin(root, "sync", ["--check"]);
  assert.equal(drift.status, 1);
  assert.match(drift.stdout, /Drift: \.github\/workflows\/ci\.yml/);
  assert.equal(bin(root, "sync").status, 0);
  const synced = read(root, ".github/workflows/ci.yml");
  assert.deepEqual(jobs(synced).ci.permissions, { contents: "read" });
  assert.deepEqual(jobs(synced)["renovate-sync"].permissions, {
    contents: "write",
    actions: "write",
  });
  assert.equal(bin(root, "sync", ["--check"]).status, 0);
  put(root, ".github/workflows/ci.yml", CI_CALLER);
  commit(root);
  assert.equal(bin(root, "sync", ["--check"]).status, 0);
});

test("the caller is dispatchable and its job holds exactly contents read, whatever the trigger shape or permissions it had", () => {
  const triggers = [
    "on: push",
    "on: [push, pull_request]",
    "on:\n  push:\n    branches: [main]",
    "on:\n  workflow_dispatch:\n",
  ];
  for (const trigger of triggers) {
    const rewritten = rewrite(
      `name: ci\n${trigger}\njobs:\n  ci:\n    uses: ${CI_NODE_REF}\n`,
    );
    const parsed = parseDocument(rewritten).toJS();
    const names = Array.isArray(parsed.on)
      ? parsed.on
      : Object(parsed.on) === parsed.on
        ? Object.keys(parsed.on)
        : [parsed.on];
    assert.ok(names.includes("workflow_dispatch"), trigger);
    assert.deepEqual(parsed.jobs.ci.permissions, { contents: "read" });
  }
  const wide = rewrite(
    `on: workflow_dispatch\njobs:\n  ci:\n    permissions: write-all\n    uses: ${CI_NODE_REF}\n`,
  );
  assert.deepEqual(parseDocument(wide).toJS().jobs.ci.permissions, {
    contents: "read",
  });
});

test("the template profile syncs the caller too, and not the mutation workflow", (t) => {
  const root = testRepo(t, false);
  const check = syncRepository(root, { check: true, profile: "template" });
  assert.equal(check.paths.includes(".github/workflows/ci.yml"), true);
  assert.equal(check.paths.includes(".github/workflows/mutation.yml"), false);
  assert.ok(
    MANAGED_ARTIFACTS.some(
      ({ path }) => path === ".github/workflows/mutation.yml",
    ),
  );
});
