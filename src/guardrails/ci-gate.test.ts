import assert from "node:assert/strict";
import test from "node:test";

import { jobsOf, syncCi, workflowWith } from "./helpers/ci-text.ts";

const RUNNER = "runs-on: blacksmith-4vcpu-ubuntu-2404";

function job(id: string, extra = "", step = "- run: pnpm test"): string {
  return `  ${id}:\n${extra}    ${RUNNER}\n    steps:\n      ${step}\n`;
}

function usesJob(id: string, extra = ""): string {
  return job(id, extra, "- uses: actions/checkout@v7");
}

const GATE_IF =
  "${{ !cancelled() && !contains(needs.*.result, 'failure') && !contains(needs.*.result, 'cancelled') }}";

function advisoriesOf(text: string): string[] {
  return syncCi(text).advisories.filter((note) => note.startsWith("Gate:"));
}

test("every hand-written job that does not need ci joins the caller's needs in file order, so a gate that wires only the first job or sorts them fails", () => {
  const { content } = syncCi(
    workflowWith(
      `${job("zeta")}${job("alpha", "    needs: zeta\n")}${job("mid")}`,
    ),
  );
  assert.deepEqual(jobsOf(content).ci.needs, ["zeta", "alpha", "mid"]);
  assert.equal(jobsOf(content).ci.if, GATE_IF);
});

test("the caller needs its jobs in a flow list placed before its uses, and a second run changes nothing, so a gate that appends needs after with or duplicates an entry fails", () => {
  const once = syncCi(workflowWith(job("lint"))).content;
  assert.match(
    once,
    /^ {2}ci:\n {4}needs: \[lint\]\n {4}if: \$\{\{ !cancelled\(\)[^\n]*\n {4}uses: /m,
  );
  assert.equal(syncCi(once).content, once);
});

test("the verdict and a job that calls a workflow are never wired, so a gate that wires a verdict not yet needing ci into a cycle, or every job of the file, fails", () => {
  const { content } = syncCi(
    workflowWith(
      `${job("lint")}  reuse:\n    uses: AntelopeJS/.github/.github/workflows/module-locks-renovate.yml@v2\n  verdict:\n    needs: [lint]\n    if: \${{ !cancelled() }}\n    runs-on: blacksmith-4vcpu-ubuntu-2404\n    steps:\n      - run: exit 0\n`,
    ),
  );
  assert.deepEqual(jobsOf(content).ci.needs, ["lint"]);
  assert.deepEqual(jobsOf(content).verdict.needs, [
    "ci",
    "lint",
    "reuse",
    "renovate-sync",
  ]);
});

test("an aggregator that needs ci is not wired and gets no advisory, so a gate that cycles ci through its own aggregator or reports it fails", () => {
  const text = workflowWith(
    `${job("lint")}${job("ubuntu", "    needs: [ci, lint]\n")}`,
  );
  const { content, advisories } = syncCi(text);
  assert.deepEqual(jobsOf(content).ci.needs, ["lint"]);
  assert.deepEqual(
    advisories.filter((note) => note.startsWith("Gate:")),
    [],
  );
});

test("a job that is no aggregator and needs ci stays unwired and is reported with the fix, so a gate that wires it into a cycle or stays silent fails", () => {
  const text = workflowWith(
    `${job("lint")}${usesJob("deploy", "    needs: ci\n")}`,
  );
  const { content } = syncCi(text);
  assert.deepEqual(jobsOf(content).ci.needs, ["lint"]);
  assert.deepEqual(advisoriesOf(text), [
    "Gate: .github/workflows/ci.yml job deploy runs beside the ci caller, so ci / checks passes when it fails. It needs ci, so ci cannot need it. Move it into an input of ci-node.yml, or have the ci job need it.",
  ]);
});

test("a job that needs ci through another job is unwired too, so a gate that checks direct needs only fails", () => {
  const text = workflowWith(
    `${usesJob("build", "    needs: ci\n")}${usesJob("publish", "    needs: build\n")}`,
  );
  const { content } = syncCi(text);
  assert.equal(jobsOf(content).ci.needs, undefined);
  assert.equal(jobsOf(content).ci.if, undefined);
  assert.equal(advisoriesOf(text).length, 2);
});

test("a caller with its own if gets nothing wired and every job beside it is reported, so a gate that overwrites the if or wires under it fails", () => {
  const own = "    if: github.event_name == 'push'\n";
  const text = workflowWith(
    `${usesJob("lint")}${job("ubuntu", "    needs: lint\n")}`,
  ).replace(
    "    uses: AntelopeJS/.github/.github/workflows/ci-node.yml@v2\n",
    `${own}    uses: AntelopeJS/.github/.github/workflows/ci-node.yml@v2\n`,
  );
  const { content } = syncCi(text);
  assert.equal(jobsOf(content).ci.needs, undefined);
  assert.equal(jobsOf(content).ci.if, "github.event_name == 'push'");
  const notes = advisoriesOf(text);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /job lint runs beside the ci caller/);
  assert.match(notes[0], /ci has its own if, which sync does not rewrite\./);
});

test("a caller that already needs jobs keeps them and gains the new ones once, whether its needs is a list or one id, so a gate that replaces the list or repeats an id fails", () => {
  for (const needs of ["[lint]", "lint"]) {
    const text = workflowWith(`${job("lint")}${job("docs")}`).replace(
      "    uses: AntelopeJS/.github/.github/workflows/ci-node.yml@v2\n",
      `    needs: ${needs}\n    uses: AntelopeJS/.github/.github/workflows/ci-node.yml@v2\n`,
    );
    const { content } = syncCi(text);
    assert.deepEqual(jobsOf(content).ci.needs, ["lint", "docs"], needs);
    assert.equal(jobsOf(content).ci.if, GATE_IF, needs);
    assert.equal(syncCi(content).content, content, needs);
  }
});

test("a workflow whose hand-written jobs all need ci leaves the caller without needs or if, so a gate that always sets the if fails", () => {
  const { content } = syncCi(workflowWith(job("ubuntu", "    needs: ci\n")));
  assert.equal(jobsOf(content).ci.needs, undefined);
  assert.equal(jobsOf(content).ci.if, undefined);
});
