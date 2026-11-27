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
  }).content;
}

const DISPATCH = {
  inputs: {
    nightly: {
      description: "Run the nightly tier, with the Windows jobs and Stress",
      type: "boolean",
      default: false,
    },
  },
};

interface TriggersView {
  pull_request?: { types?: string[] };
  merge_group?: null;
  push?: { branches?: string[] };
  schedule?: { cron: string }[];
  workflow_dispatch?: typeof DISPATCH;
}

function triggers(text: string): TriggersView {
  return parseDocument(text).toJS().on;
}

function withInputs(text: string): Record<string, string | boolean> {
  return parseDocument(text).toJS().jobs.ci.with ?? {};
}

const PULL_REQUEST_TYPES = [
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
];

const TRUNK_TRIGGERS: TriggersView = {
  pull_request: {
    types: [...PULL_REQUEST_TYPES, "labeled", "unlabeled"],
  },
  merge_group: null,
  push: { branches: ["main"] },
  schedule: [{ cron: "17 2 * * *" }],
  workflow_dispatch: DISPATCH,
};

const WINDOWS_CALLER = `jobs:\n  ci:\n    uses: ${CI_NODE_REF}\n    with:\n      windows: true\n      windows-pull-requests: true\n`;

test("a caller declares exactly the trunk triggers whatever it had, so a rewrite that keeps a push to next, drops merge_group or only adds dispatch fails", () => {
  const priors = [
    "on: push",
    "on: [push, pull_request]",
    "on:\n  push:\n    branches: [main, next]\n  pull_request:\n  workflow_dispatch:",
    "on:\n  workflow_dispatch:\n  release:",
  ];
  for (const prior of priors)
    assert.deepEqual(
      triggers(rewrite(`${prior}\njobs:\n  ci:\n    uses: ${CI_NODE_REF}\n`)),
      TRUNK_TRIGGERS,
      prior,
    );
  assert.deepEqual(triggers(CI_CALLER), TRUNK_TRIGGERS);
  assert.doesNotMatch(CI_CALLER, /\bnext\b|develop/);
});

test("a trunk caller from 0.8.5 gains label events and its ci job stays unconditional, so a sync that leaves ci:full without a run or skips the caller on other labels fails", () => {
  const released = CI_CALLER.replace(
    /types: \[[^\]]*\]/,
    `types: [${PULL_REQUEST_TYPES.join(", ")}]`,
  );
  assert.notEqual(released, CI_CALLER);
  const rewritten = rewrite(released);
  assert.deepEqual(triggers(rewritten), TRUNK_TRIGGERS);
  assert.equal(parseDocument(rewritten).toJS().jobs.ci.if, undefined);
});

test("cloud keeps its develop integration branch and gets the merge_group trigger of its develop merge queue, and its pull requests rerun on label events so ci:full applies, so a sync that moves every package to trunk, drops the profile or omits merge_group, labeled or unlabeled fails", () => {
  const cloud = ciProfile("@antelopejs-private/cloud");
  const develop: TriggersView = {
    pull_request: { types: [...PULL_REQUEST_TYPES, "labeled", "unlabeled"] },
    merge_group: null,
    push: { branches: ["develop"] },
    schedule: TRUNK_TRIGGERS.schedule,
    workflow_dispatch: DISPATCH,
  };
  const rewritten = rewrite(CI_CALLER, cloud);
  assert.deepEqual(triggers(rewritten), develop);
  assert.equal(rewrite(rewritten, cloud), rewritten);
  assert.deepEqual(
    triggers(ciWorkflow(undefined, [], [], { profile: cloud }).content),
    develop,
  );
  assert.deepEqual(triggers(rewrite(CI_CALLER)), TRUNK_TRIGGERS);
});

test("a second rewrite of the trunk triggers changes nothing, so a merge_group with a null value that does not round-trip fails", () => {
  const once = rewrite(
    "on: push\njobs:\n  ci:\n    uses: " + CI_NODE_REF + "\n",
  );
  assert.match(once, /\n {2}merge_group:\n/);
  assert.equal(rewrite(once), once);
  assert.equal(rewrite(CI_CALLER), CI_CALLER);
});

test("rewritten triggers keep the blank line before the next key, so a rewrite that glues permissions to workflow_dispatch fails", () => {
  const rewritten = rewrite(
    `on:\n  push:\n    branches: [next]\n  workflow_dispatch:\n\npermissions:\n  contents: read\n\njobs:\n  ci:\n    uses: ${CI_NODE_REF}\n`,
  );
  assert.match(rewritten, /default: false\n\npermissions:/);
});

test("the comments of replaced triggers go with them and a dedented comment under the last trigger stays above permissions, which a rewrite that replaces on before restoring empty-value comments drops", () => {
  const rewritten = rewrite(
    `on:\n  push:\n    branches: [main]\n  # No branch filter\n  pull_request:\n\n  # only pull requests\n\n# least privilege\npermissions:\n  contents: read\njobs:\n  ci:\n    uses: ${CI_NODE_REF}\n`,
  );
  assert.doesNotMatch(rewritten, /branch filter|only pull requests/);
  assert.match(rewritten, /default: false\n\n# least privilege\npermissions:/);
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
      ["renovate-sync", "test-job", "nightly"],
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
    const written = withInputs(
      ciWorkflow(undefined, [], [], { profile }).content,
    );
    assert.equal(Object.hasOwn(written, "windows"), false, name);
    assert.equal(Object.hasOwn(written, "windows-pull-requests"), false, name);
  }
});

test("a caller whose only input asked for Windows loses its with block rather than keeping an empty one", () => {
  const text = `on: push\njobs:\n  ci:\n    uses: ${CI_NODE_REF}\n  other:\n    uses: ${CI_NODE_REF}\n    with:\n      windows: true\n`;
  const rewritten = rewrite(text);
  assert.equal(parseDocument(rewritten).toJS().jobs.other.with, undefined);
});

test("a synced ci.yml triggers on the merge queue and pushes only to main, and sync --check fails a caller that still pushes on next", (t) => {
  const root = testRepo(t, false);
  assert.equal(bin(root, "sync").status, 0);
  commit(root);
  const branches = bin(root, "sync", ["--check"]);
  assert.equal(branches.status, 0, branches.stdout);
  const synced = read(root, ".github/workflows/ci.yml");
  assert.deepEqual(triggers(synced), TRUNK_TRIGGERS);
  assert.doesNotMatch(synced, /\bnext\b/);
  put(
    root,
    ".github/workflows/ci.yml",
    synced.replace("branches: [main]", "branches: [main, next]"),
  );
  commit(root);
  const drift = bin(root, "sync", ["--check"]);
  assert.equal(drift.status, 1);
  assert.match(drift.stdout, /Drift: \.github\/workflows\/ci\.yml/);
});
