import assert from "node:assert/strict";
import test from "node:test";
import { parseDocument } from "yaml";

import {
  CI_CALLER,
  CI_NODE_REF,
  ciProfile,
  ciWorkflow,
  type CiProfile,
} from "./ci-workflow.ts";
import { bin, commit, put, read, testRepo } from "./helpers/test-repo.ts";
import { ciNodeCallers, ciRenovateSyncCallers } from "./workflow.ts";

function rewrite(text: string, profile?: CiProfile): string {
  return ciWorkflow(text, ciNodeCallers(text), ciRenovateSyncCallers(text), {
    profile,
  });
}

interface TriggersView {
  pull_request?: { types?: string[] };
  push?: { branches?: string[] };
  schedule?: { cron: string }[];
  workflow_dispatch?: null;
}

function triggers(text: string): TriggersView {
  return parseDocument(text).toJS().on;
}

function withInputs(text: string): Record<string, string | boolean> {
  return parseDocument(text).toJS().jobs.ci.with ?? {};
}

function threeTier(branch: string): TriggersView {
  return {
    pull_request: {
      types: ["opened", "synchronize", "reopened", "ready_for_review"],
    },
    push: { branches: [branch] },
    schedule: [{ cron: "17 2 * * *" }],
    workflow_dispatch: null,
  };
}

const WINDOWS_CALLER = `jobs:\n  ci:\n    uses: ${CI_NODE_REF}\n    with:\n      windows: true\n      windows-pull-requests: true\n`;

test("a caller declares exactly the three-tier triggers whatever it had, so a rewrite that keeps a push to main or only adds dispatch fails", () => {
  const priors = [
    "on: push",
    "on: [push, pull_request]",
    "on:\n  push:\n    branches: [main, next]\n  pull_request:\n  workflow_dispatch:",
    "on:\n  workflow_dispatch:\n  release:",
  ];
  for (const prior of priors)
    assert.deepEqual(
      triggers(rewrite(`${prior}\njobs:\n  ci:\n    uses: ${CI_NODE_REF}\n`)),
      threeTier("next"),
      prior,
    );
  assert.deepEqual(triggers(CI_CALLER), threeTier("next"));
});

test("cloud pushes on develop and every other package on next, so a profile table that ignores the package name fails", () => {
  const cloud = ciProfile("@antelopejs-private/cloud");
  assert.deepEqual(triggers(rewrite(CI_CALLER, cloud)), threeTier("develop"));
  assert.deepEqual(
    triggers(ciWorkflow(undefined, [], [], { profile: cloud })),
    threeTier("develop"),
  );
  for (const name of ["@antelopejs/mongodb", "toString", undefined])
    assert.equal(ciProfile(name).integrationBranch, "next", name);
});

test("the comments of replaced triggers go with them and a dedented comment under the last trigger stays above permissions, which a rewrite that replaces on before restoring empty-value comments drops", () => {
  const rewritten = rewrite(
    `on:\n  push:\n    branches: [main]\n  # No branch filter\n  pull_request:\n\n  # only pull requests\n\n# least privilege\npermissions:\n  contents: read\njobs:\n  ci:\n    uses: ${CI_NODE_REF}\n`,
  );
  assert.doesNotMatch(rewritten, /branch filter|only pull requests/);
  assert.match(
    rewritten,
    /workflow_dispatch:\n\n# least privilege\npermissions:/,
  );
  assert.equal(rewrite(rewritten), rewritten);
});

test("outside antelopejs and cloud-sdk sync drops windows: true and windows-pull-requests and keeps the opt-out windows: false, so a sync that keeps an opt-in or erases an opt-out fails", () => {
  const dropped = withInputs(rewrite(WINDOWS_CALLER));
  assert.equal(Object.hasOwn(dropped, "windows"), false);
  assert.equal(Object.hasOwn(dropped, "windows-pull-requests"), false);
  assert.equal(dropped["renovate-sync"], false);
  const optOut = WINDOWS_CALLER.replace(
    "windows: true\n      windows-pull-requests: true",
    "windows: false",
  );
  assert.equal(withInputs(rewrite(optOut)).windows, false);
  for (const input of [
    'windows: "false"',
    "windows: ${{ vars.WINDOWS }}",
    "windows-pull-requests: false",
  ]) {
    const asked = WINDOWS_CALLER.replace(
      "windows: true\n      windows-pull-requests: true",
      input,
    );
    assert.deepEqual(
      Object.keys(withInputs(rewrite(asked))),
      ["renovate-sync", "test-job"],
      input,
    );
  }
});

test("antelopejs and cloud-sdk keep their Windows inputs and sync writes none, so a sync that drops them there or writes them for a new caller fails", () => {
  for (const name of ["@antelopejs/core", "cloud-sdk-workspace"]) {
    const profile = ciProfile(name);
    const kept = withInputs(rewrite(WINDOWS_CALLER, profile));
    assert.equal(kept.windows, true, name);
    assert.equal(kept["windows-pull-requests"], true, name);
    const written = withInputs(ciWorkflow(undefined, [], [], { profile }));
    assert.equal(Object.hasOwn(written, "windows"), false, name);
    assert.equal(Object.hasOwn(written, "windows-pull-requests"), false, name);
  }
});

test("a caller whose only input asked for Windows loses its with block rather than keeping an empty one", () => {
  const text = `on: push\njobs:\n  ci:\n    uses: ${CI_NODE_REF}\n  other:\n    uses: ${CI_NODE_REF}\n    with:\n      windows: true\n`;
  const rewritten = rewrite(text);
  assert.equal(parseDocument(rewritten).toJS().jobs.other.with, undefined);
});

test("sync --check passes a repository with no next branch and fails a caller that still pushes on main", (t) => {
  const root = testRepo(t, false);
  put(
    root,
    "guardrails.ratchet.json",
    '{"rules":{"eslint/no-alert":1},"oversizeFiles":{}}\n',
  );
  assert.equal(bin(root, "sync").status, 0);
  commit(root);
  const branches = bin(root, "sync", ["--check"]);
  assert.equal(branches.status, 0, branches.stdout);
  const synced = read(root, ".github/workflows/ci.yml");
  put(
    root,
    ".github/workflows/ci.yml",
    synced.replace("branches: [next]", "branches: [main, next]"),
  );
  commit(root);
  const drift = bin(root, "sync", ["--check"]);
  assert.equal(drift.status, 1);
  assert.match(drift.stdout, /Drift: \.github\/workflows\/ci\.yml/);
});
