import assert from "node:assert/strict";
import test from "node:test";

import { GATE_CONDITION } from "./ci-gate.ts";
import { jobsOf, syncCi, workflowWith } from "./helpers/ci-text.ts";

const RUNNER = "runs-on: blacksmith-4vcpu-ubuntu-2404";
const CALLER =
  "    uses: AntelopeJS/.github/.github/workflows/ci-node.yml@v2\n";

function job(id: string, extra = "", step = "- run: pnpm test"): string {
  return `  ${id}:\n${extra}    ${RUNNER}\n    steps:\n      ${step}\n`;
}

function usesJob(id: string, extra = ""): string {
  return job(id, extra, "- uses: actions/checkout@v7");
}

function withCaller(jobs: string, head: string): string {
  return workflowWith(jobs).replace(CALLER, `${head}${CALLER}`);
}

function gateNotes(text: string): string[] {
  return syncCi(text).advisories.filter((note) => note.startsWith("Gate:"));
}

test("a caller an earlier sync wired loses the hand-written jobs from its needs and its gate if, and a second run changes nothing, so a sync that keeps the wiring, which skips ci and leaves ci / checks unreported when a job fails, fails", () => {
  const text = withCaller(
    `${job("e2e")}${job("leaks")}`,
    `    needs: [e2e, leaks]\n    if: ${GATE_CONDITION}\n`,
  );
  const { content } = syncCi(text);
  assert.equal(jobsOf(content).ci.needs, undefined);
  assert.equal(jobsOf(content).ci.if, undefined);
  assert.deepEqual(jobsOf(content).verdict.needs, [
    "ci",
    "e2e",
    "leaks",
    "renovate-sync",
  ]);
  assert.equal(syncCi(content).content, content);
});

test("unwiring keeps a need the caller reads and the gate if with it, so a sync that drops every need breaks a caller that passes needs.<id>.outputs to ci-node.yml", () => {
  const text = withCaller(
    `${job("tier")}${job("e2e")}`,
    `    needs: [tier, e2e]\n    if: ${GATE_CONDITION}\n`,
  ).replace(
    "    uses: AntelopeJS/.github/.github/workflows/ci-node.yml@v2\n",
    "    uses: AntelopeJS/.github/.github/workflows/ci-node.yml@v2\n    with:\n      setup-commands: echo ${{ needs.tier.outputs.tier }}\n",
  );
  const { content } = syncCi(text);
  assert.deepEqual(jobsOf(content).ci.needs, ["tier"]);
  assert.equal(jobsOf(content).ci.if, GATE_CONDITION);
});

test("a caller with needs under its own if keeps both, so a sync that unwires every caller with needs drops a repository's own wiring", () => {
  const text = withCaller(
    job("lint"),
    "    needs: [lint]\n    if: github.event_name == 'push'\n",
  );
  const { content } = syncCi(text);
  assert.deepEqual(jobsOf(content).ci.needs, ["lint"]);
  assert.equal(jobsOf(content).ci.if, "github.event_name == 'push'");
});

test("the caller needs no hand-written job and one advisory names the aggregator that needs them all with ci, so a sync that wires them, or reports one advisory per job, fails", () => {
  const text = workflowWith(
    `${job("select")}${usesJob("e2e", "    needs: select\n")}${job("ubuntu", "    needs: [select, ci, e2e]\n    if: always()\n")}`,
  );
  const { content } = syncCi(text);
  assert.equal(jobsOf(content).ci.needs, undefined);
  assert.equal(jobsOf(content).ci.if, undefined);
  assert.deepEqual(gateNotes(text), [
    "Gate: .github/workflows/ci.yml jobs select, e2e run beside the ci caller, so ci / checks passes when one fails. ubuntu needs them with ci, so require ubuntu in the ruleset.",
  ]);
  assert.equal(syncCi(content).content, content);
});

test("an aggregator that misses a job is not named and the verdict is, so a sync that names the first aggregator needing ci fails", () => {
  const notes = gateNotes(
    workflowWith(
      `${job("e2e")}${usesJob("report", "    needs: e2e\n")}${job("ubuntu", "    needs: [ci, e2e]\n    if: always()\n")}`,
    ),
  );
  assert.equal(notes.length, 1);
  assert.match(notes[0], /jobs e2e, report run beside/);
  assert.match(notes[0], /\. verdict needs them with ci, so require verdict /);
});

test("a workflow whose hand-written jobs are all aggregators gets no advisory, so a sync that reports an empty job list fails", () => {
  assert.deepEqual(
    gateNotes(workflowWith(job("ubuntu", "    needs: ci\n"))),
    [],
  );
});

test("an aggregator that a failed need would skip is not named and the verdict is, since a skipped required job reports success, so a sync that names any aggregator needing ci and the jobs fails", () => {
  assert.deepEqual(
    gateNotes(
      workflowWith(
        `${usesJob("e2e")}${job("ubuntu", "    needs: [ci, e2e]\n")}`,
      ),
    ),
    [
      "Gate: .github/workflows/ci.yml job e2e runs beside the ci caller, so ci / checks passes when it fails. verdict needs it with ci, so require verdict in the ruleset.",
    ],
  );
});

test("a job ci already needs is left out of the advisory, so a sync that lists every hand-written job fails", () => {
  const notes = gateNotes(
    withCaller(`${usesJob("lint")}${usesJob("docs")}`, "    needs: [lint]\n"),
  );
  assert.equal(notes.length, 1);
  assert.match(notes[0], /: \.github\/workflows\/ci\.yml job docs runs beside/);
});
