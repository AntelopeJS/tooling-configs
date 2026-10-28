import assert from "node:assert/strict";
import test from "node:test";
import { parseDocument } from "yaml";

import {
  CI_CALLER,
  CI_CONTEXT,
  CI_NODE_REF,
  ciWorkflow,
  mutationCaller,
} from "./ci-workflow.ts";
import { MANAGED_ARTIFACTS, syncRepository } from "./sync.ts";
import { bin, commit, put, read, testRepo } from "./helpers/test-repo.ts";
import { ciNodeCallers } from "./workflow.ts";

function rewrite(text: string): string {
  return ciWorkflow(text, ciNodeCallers(text));
}

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
  assert.match(rewritten, /needs: \[ ci \]/);
  assert.match(rewritten, /needs: ci\n/);
  assert.equal(rewrite(rewritten), rewritten);
});

test("a caller already named ci with no name is returned byte for byte, comments included", () => {
  const text = `# keep me\nname: ci\non: [push, workflow_dispatch]\njobs:\n  ci:\n    permissions:\n      contents: write\n      actions: write\n    uses: ${CI_NODE_REF}\n`;
  assert.equal(rewrite(text), text);
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

test("the caller is dispatchable and its job holds exactly contents and actions write, whatever the trigger shape or permissions it had", () => {
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
    assert.deepEqual(parsed.jobs.ci.permissions, {
      contents: "write",
      actions: "write",
    });
  }
  const wide = rewrite(
    `on: workflow_dispatch\njobs:\n  ci:\n    permissions: write-all\n    uses: ${CI_NODE_REF}\n`,
  );
  assert.deepEqual(parseDocument(wide).toJS().jobs.ci.permissions, {
    contents: "write",
    actions: "write",
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
