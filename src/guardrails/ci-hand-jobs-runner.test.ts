import assert from "node:assert/strict";
import test from "node:test";

import { BLACKSMITH_RUNNERS, blacksmithRunsOn } from "./ci-hand-jobs.ts";
import { CI_PATH } from "./ci-workflow.ts";
import { jobsOf, syncCi, workflowWith } from "./helpers/ci-text.ts";

const LINUX = BLACKSMITH_RUNNERS.linux;
const WINDOWS = BLACKSMITH_RUNNERS.windows;

function runnerOf(runsOn: string): string | undefined {
  const text = syncCi(
    workflowWith(
      `  lint:\n    runs-on: ${runsOn}\n    steps:\n      - run: pnpm lint\n`,
    ),
  ).content;
  return jobsOf(text).lint["runs-on"];
}

test("a literal label maps to the Blacksmith image of its OS and a macOS or Arm label to none, so an implementation that maps every label to Linux or keeps a self-hosted label fails", () => {
  for (const label of ["macos-latest", "macos-14", "ubuntu-24.04-arm"])
    assert.equal(blacksmithRunsOn(label), undefined, label);
  for (const label of ["ubuntu-latest", "ubuntu-22.04", "self-hosted", LINUX])
    assert.equal(blacksmithRunsOn(label), LINUX, label);
  for (const label of ["windows-latest", "Windows-2022", WINDOWS])
    assert.equal(blacksmithRunsOn(label), WINDOWS, label);
});

test("a chain of vars and literals maps by its last literal, so an implementation that reads the first term or ignores a Windows fallback fails", () => {
  assert.equal(
    blacksmithRunsOn("${{ vars.RUNNER_CI || 'ubuntu-latest' }}"),
    LINUX,
  );
  assert.equal(
    blacksmithRunsOn(
      "${{ vars.RUNNER_CI_SMALL || vars.RUNNER_CI || 'ubuntu-latest' }}",
    ),
    LINUX,
  );
  assert.equal(
    blacksmithRunsOn("${{ vars.RUNNER_WINDOWS || 'windows-latest' }}"),
    WINDOWS,
  );
  assert.equal(
    blacksmithRunsOn("${{ 'windows-latest' || 'ubuntu-latest' }}"),
    LINUX,
  );
});

test("any other expression stays unresolved, so an implementation that maps every string containing a literal to Linux fails", () => {
  for (const value of [
    "${{ matrix.os }}",
    "${{ github.event_name == 'push' && 'windows-latest' || 'ubuntu-latest' }}",
    "${{ fromJSON('[\"ubuntu-latest\"]')[0] }}",
    "ubuntu-${{ matrix.version }}",
    "${{ vars.RUNNER_CI && 'ubuntu-latest' }}",
  ])
    assert.equal(blacksmithRunsOn(value), undefined, value);
});

test("a hand-written job's runner is rewritten in the file and a second run changes nothing, so a sync that writes it back every run fails", () => {
  const before = workflowWith(
    "  lint:\n    runs-on: ${{ vars.RUNNER_CI || 'ubuntu-latest' }}\n    steps:\n      - run: pnpm lint\n  win:\n    runs-on: windows-latest\n    steps:\n      - run: pnpm test\n",
  );
  const once = syncCi(before);
  assert.equal(jobsOf(once.content).lint["runs-on"], LINUX);
  assert.equal(jobsOf(once.content).win["runs-on"], WINDOWS);
  assert.deepEqual(
    once.advisories.filter((note) => note.startsWith("Runner:")),
    [],
  );
  assert.equal(syncCi(once.content).content, once.content);
});

test("a job that calls a workflow keeps its fields and the verdict gets the literal runner, so an implementation that rewrites job-level uses or leaves the verdict's variable fails", () => {
  const text = syncCi(workflowWith("")).content;
  assert.equal(jobsOf(text).verdict["runs-on"], LINUX);
  assert.equal(jobsOf(text).ci["runs-on"], undefined);
});

test("a runner no literal stands for stays and is reported once per job, so an implementation that rewrites a list to Linux or reports nothing fails", () => {
  for (const runsOn of [
    "[self-hosted, linux]",
    "{ group: ci, labels: [linux] }",
    "${{ github.event_name == 'push' && 'a' || 'b' }}",
  ]) {
    const result = syncCi(
      workflowWith(
        `  lint:\n    runs-on: ${runsOn}\n    steps:\n      - run: pnpm lint\n`,
      ),
    );
    assert.notEqual(jobsOf(result.content).lint["runs-on"], LINUX, runsOn);
    const runner = result.advisories.filter((note) =>
      note.startsWith("Runner:"),
    );
    assert.equal(runner.length, 1, runsOn);
    assert.match(
      runner[0],
      new RegExp(
        `^Runner: ${CI_PATH.replaceAll(".", "\\.")} job lint runs on .+, which sync cannot resolve to ${LINUX} or ${WINDOWS}\\. Use a literal label\\.$`,
      ),
    );
  }
  assert.equal(runnerOf(LINUX), LINUX);
});

test("a matrix.os list is rewritten item by item and runs-on stays, so an implementation that rewrites runs-on to one label or leaves the list fails", () => {
  const text = syncCi(
    workflowWith(
      "  test:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, windows-latest]\n    steps:\n      - run: pnpm test\n",
    ),
  );
  const job = jobsOf(text.content).test;
  assert.equal(job["runs-on"], "${{ matrix.os }}");
  assert.deepEqual(job.strategy, { matrix: { os: [LINUX, WINDOWS] } });
  assert.deepEqual(
    text.advisories.filter((note) => note.startsWith("Runner:")),
    [],
  );
  assert.equal(syncCi(text.content).content, text.content);
});

test("a matrix.os that is not a literal list, or whose value an if compares, is reported and untouched, so an implementation that rewrites the list under a comparison on the old label fails", () => {
  const generated = syncCi(
    workflowWith(
      "  test:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: ${{ fromJSON(vars.OSES) }}\n    steps:\n      - run: pnpm test\n",
    ),
  );
  assert.equal(
    generated.advisories.filter((n) => n.startsWith("Runner:")).length,
    1,
  );
  const compared = syncCi(
    workflowWith(
      "  test:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, windows-latest]\n    steps:\n      - if: matrix.os == 'windows-latest'\n        run: pnpm win\n",
    ),
  );
  assert.deepEqual(jobsOf(compared.content).test.strategy, {
    matrix: { os: ["ubuntu-latest", "windows-latest"] },
  });
  assert.equal(
    compared.advisories.filter((n) => n.startsWith("Runner:")).length,
    1,
  );
  for (const job of [
    "  test:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, windows-latest]\n    steps:\n      - shell: ${{ matrix.os == 'windows-latest' && 'pwsh' || 'bash' }}\n        run: pnpm test\n",
    "  test:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, windows-latest]\n        node: [22, 24]\n        exclude:\n          - os: windows-latest\n            node: 22\n    steps:\n      - run: pnpm test\n",
    "  test:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, macos-latest]\n    steps:\n      - run: pnpm test\n",
  ]) {
    const kept = syncCi(workflowWith(job));
    assert.ok(
      JSON.stringify(jobsOf(kept.content).test.strategy).includes(
        "ubuntu-latest",
      ),
      job,
    );
    assert.equal(
      kept.advisories.filter((n) => n.startsWith("Runner:")).length,
      1,
      job,
    );
  }
});
