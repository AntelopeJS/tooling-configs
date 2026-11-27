import assert from "node:assert/strict";
import test from "node:test";
import { parseDocument } from "yaml";

import { CI_CALLER, CI_NODE_REF, ciWorkflow } from "./ci-workflow.ts";
import { verdictNotes } from "./ci-verdict.ts";
import {
  PACKAGE_ROOT,
  bin,
  commit,
  put,
  read,
  testRepo,
} from "./helpers/test-repo.ts";
import { ciNodeCallers, ciRenovateSyncCallers } from "./workflow.ts";

interface JobView {
  needs?: string | string[];
  if?: string;
  with?: Record<string, string | boolean>;
  steps?: unknown[];
}

interface WorkflowView {
  on: {
    workflow_dispatch?: {
      inputs?: {
        nightly?: { description: string; type: string; default: boolean };
      };
    };
  };
  jobs: Record<string, JobView>;
}

function rewrite(text: string): string {
  return ciWorkflow(text, ciNodeCallers(text), ciRenovateSyncCallers(text));
}

function view(text: string): WorkflowView {
  return parseDocument(text).toJS();
}

/** What keeps the verdict of `text` from covering the file: each job it does not need, and an `if` other than !cancelled(). */
function uncovered(text: string): string[] {
  const { jobs } = view(text);
  const verdict = jobs.verdict;
  if (!verdict) return ["no verdict job"];
  const needs = [verdict.needs ?? []].flat();
  const missing = Object.keys(jobs).filter(
    (id) => id !== "verdict" && !needs.includes(id),
  );
  return verdict.if === "${{ !cancelled() }}"
    ? missing
    : [...missing, `if: ${verdict.if}`];
}

const E2E = `  e2e:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm run e2e
`;

test("a new caller gets a verdict job needing ci and renovate-sync with if: ${{ !cancelled() }}, so a sync that leaves the Renovate sync a result the merge queue merges past fails", () => {
  const created = ciWorkflow(undefined, [], []);
  assert.deepEqual(uncovered(created), []);
  assert.deepEqual(Object.keys(view(created).jobs), [
    "ci",
    "renovate-sync",
    "verdict",
  ]);
  assert.equal(rewrite(created), created);
});

test("a caller declares the nightly dispatch input and forwards it to ci-node.yml, so a sync that leaves gh workflow run -f nightly=true running the full tier fails", () => {
  const rewritten = rewrite(
    `on: push\njobs:\n  ci:\n    uses: ${CI_NODE_REF}\n`,
  );
  const { on, jobs } = view(rewritten);
  assert.deepEqual(on.workflow_dispatch?.inputs?.nightly, {
    description: "Run the nightly tier, with the Windows jobs and Stress",
    type: "boolean",
    default: false,
  });
  assert.equal(jobs.ci.with?.nightly, "${{ inputs.nightly == true }}");
  assert.equal(rewrite(rewritten), rewritten);
});

test("a verdict that misses a repository job needs it after sync and keeps its own steps, so a sync that only adds a missing verdict or rewrites its steps fails", () => {
  const steps = "    steps:\n      - run: echo own\n";
  const partial = `${CI_CALLER}${E2E}`.replace(
    /    if: \$\{\{ !cancelled\(\) \}\}\n[\s\S]*?(?=  e2e:)/,
    `    runs-on: ubuntu-latest\n${steps}`,
  );
  assert.notEqual(partial, `${CI_CALLER}${E2E}`);
  const rewritten = rewrite(partial);
  assert.deepEqual(uncovered(rewritten), []);
  assert.deepEqual(view(rewritten).jobs.verdict.steps, [{ run: "echo own" }]);
  assert.equal(rewrite(rewritten), rewritten);
});

test("a verdict whose if reads !cancelled() without the expression braces is kept, so a sync that rewrites an equivalent condition on every run fails", () => {
  const bare = CI_CALLER.replace(
    "if: ${{ !cancelled() }}",
    "if: '!cancelled()'",
  );
  assert.notEqual(bare, CI_CALLER);
  assert.equal(rewrite(bare), bare);
});

test("a verdict that runs with always() gets if: ${{ !cancelled() }}, so a sync that leaves a cancelled run's verdict waiting for a runner only to fail fails", () => {
  for (const condition of [
    "${{ always() }}",
    "always()",
    "${{ success() }}",
    "${{ !cancelled() && github.event_name != 'push' }}",
  ]) {
    const other = CI_CALLER.replace(
      "if: ${{ !cancelled() }}",
      `if: ${condition}`,
    );
    assert.notEqual(other, CI_CALLER, condition);
    const rewritten = rewrite(other);
    assert.deepEqual(uncovered(rewritten), [], condition);
    assert.equal(rewrite(rewritten), rewritten, condition);
  }
});

test("sync refuses a job that needs verdict as a scalar or a list and names it, so a sync that has the verdict need it back, or that reads only list needs, fails", () => {
  const notify = `  notify:
    needs: [ci, verdict]
    runs-on: ubuntu-latest
    steps:
      - run: echo done
`;
  assert.throws(
    () => rewrite(`${CI_CALLER}${notify}`),
    /\.github\/workflows\/ci\.yml: job notify needs verdict/,
  );
  assert.throws(
    () => rewrite(`${CI_CALLER}${notify.replace("[ci, verdict]", "verdict")}`),
    /\.github\/workflows\/ci\.yml: job notify needs verdict/,
  );
});

test("sync --check fails a ci.yml whose verdict misses a job, names that job, and passes once sync wrote it, so a check that reports only the drifted file fails", (t) => {
  const root = testRepo(t, false);
  assert.equal(bin(root, "sync").status, 0);
  const synced = read(root, ".github/workflows/ci.yml");
  put(root, ".github/workflows/ci.yml", `${synced}${E2E}`);
  commit(root);
  const drift = bin(root, "sync", ["--check"]);
  assert.equal(drift.status, 1);
  assert.match(drift.stdout, /Drift: \.github\/workflows\/ci\.yml/);
  assert.match(drift.stdout, /verdict does not need e2e/);
  assert.equal(bin(root, "sync").status, 0);
  assert.deepEqual(uncovered(read(root, ".github/workflows/ci.yml")), []);
  commit(root);
  const check = bin(root, "sync", ["--check"]);
  assert.equal(check.status, 0, check.stdout);
});

test("the verdict note names no job sync renamed or added, so a note that reads the rewritten verdict alone blames the verdict for the caller renamed to ci", () => {
  const renamed = CI_CALLER.replace("  ci:\n", "  checks:\n").replace(
    "needs: [ci, renovate-sync]",
    "needs: [checks]",
  );
  assert.notEqual(renamed, CI_CALLER);
  const rewritten = rewrite(renamed);
  assert.deepEqual(uncovered(rewritten), []);
  assert.deepEqual(verdictNotes("ci.yml", renamed, rewritten), [
    "ci.yml: verdict does not need renovate-sync, so the merge queue merges past its result. Sync adds it to the needs: of verdict.",
  ]);
});

test("the verdict note says a ci.yml has no verdict job, so a note that lists every job as missed from a verdict that does not exist fails", () => {
  const without = CI_CALLER.slice(0, CI_CALLER.indexOf("  verdict:"));
  assert.notEqual(without, CI_CALLER);
  assert.deepEqual(verdictNotes("ci.yml", without, rewrite(without)), [
    "ci.yml: has no verdict job, so the merge queue merges past every result. Sync adds one that needs every other job.",
  ]);
});

test("tooling-configs' own ci.yml has a verdict job needing every job with if: ${{ !cancelled() }}, so a job added without the verdict needing it fails", () => {
  assert.deepEqual(
    uncovered(read(PACKAGE_ROOT, ".github/workflows/ci.yml")),
    [],
  );
});
