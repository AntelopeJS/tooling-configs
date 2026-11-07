import assert from "node:assert/strict";
import test from "node:test";

import { ciDuration, median, redBranch } from "./checks/ci-health.ts";
import { workflowRun } from "./decode.ts";
import { ago, run } from "./helpers/builders.ts";
import { FakeApi, fixture } from "./helpers/fake-api.ts";
import { object, children, isObject } from "./json.ts";
import type { CheckResult } from "./types.ts";

function world(runs: ReturnType<typeof run>[], tier = "N1"): FakeApi {
  return new FakeApi().org([{ name: "mongodb", tier }]).ci("mongodb", runs);
}

function keys(result: CheckResult): string[] {
  assert.equal(result.kind, "findings");
  return result.kind === "findings"
    ? result.findings.map(({ key }) => key)
    : [];
}

test("a streak red for more than 24 hours is a finding, a shorter one or one broken by a green run is not", async () => {
  const long = world([
    run(3, "failure", 2),
    run(2, "failure", 30),
    run(1, "success", 50),
  ]);
  assert.deepEqual(keys(await redBranch.run(long.context())), [
    "mongodb|red-branch|main",
  ]);
  const short = world([
    run(3, "failure", 2),
    run(2, "failure", 20),
    run(1, "success", 50),
  ]);
  assert.deepEqual(keys(await redBranch.run(short.context())), []);
  const mended = world([run(3, "success", 2), run(2, "failure", 40)]);
  assert.deepEqual(keys(await redBranch.run(mended.context())), []);
});

test("a cancelled run neither starts nor ends a red streak", async () => {
  const api = world([run(3, "cancelled", 1), run(2, "failure", 30)]);
  assert.deepEqual(keys(await redBranch.run(api.context())), [
    "mongodb|red-branch|main",
  ]);
});

test("a repository without ci.yml is skipped quietly", async () => {
  const api = new FakeApi().org([{ name: "mongodb" }]);
  assert.deepEqual(keys(await redBranch.run(api.context())), []);
});

test("the recorded runs of antelopejs decode into durations", () => {
  const runs = children(
    object(fixture("ci-runs-antelopejs.json"), "runs"),
    "workflow_runs",
  ).map((entry) => workflowRun(entry));
  assert.ok(runs.length > 10);
  assert.ok(runs.every((entry) => entry.updatedAt >= entry.startedAt));
});

function timed(recent: number, usual: number): ReturnType<typeof run>[] {
  const runs: ReturnType<typeof run>[] = [];
  for (let index = 0; index < 20; index++)
    runs.push(
      run(index + 1, "success", 1 + index * 6, index < 10 ? recent : usual),
    );
  return runs;
}

test("the median of the last 10 runs is judged against the 30-day baseline by +20% or +60 s, whichever trips first", async () => {
  assert.deepEqual(
    keys(await ciDuration.run(world(timed(125, 100)).context())),
    ["mongodb|ci-duration|main"],
  );
  assert.deepEqual(
    keys(await ciDuration.run(world(timed(119, 100)).context())),
    [],
  );
  assert.deepEqual(keys(await ciDuration.run(world(timed(85, 20)).context())), [
    "mongodb|ci-duration|main",
  ]);
  assert.deepEqual(
    keys(await ciDuration.run(world(timed(500, 100).slice(0, 12)).context())),
    [],
  );
});

function slowdown(
  workflowSha: (index: number) => string | undefined,
): ReturnType<typeof run>[] {
  return Array.from({ length: 20 }, (_, index) =>
    run(
      index + 1,
      "success",
      1 + index * 6,
      index < 10 ? 125 : 100,
      workflowSha(index),
    ),
  );
}

test("a slowdown that starts with a new referenced-workflow sha is accepted as the new baseline, the same slowdown under an unchanged sha is a finding", async () => {
  const changed = world(slowdown((index) => (index < 10 ? "new" : "old")));
  assert.deepEqual(keys(await ciDuration.run(changed.context())), []);
  const unchanged = world(slowdown(() => "same"));
  assert.deepEqual(keys(await ciDuration.run(unchanged.context())), [
    "mongodb|ci-duration|main",
  ]);
});

test("a slowdown that starts after a commit to ci.yml is accepted, a commit older than the whole window changes nothing", async () => {
  const after = world(timed(125, 100)).callerChanged("mongodb", ago(57));
  assert.deepEqual(keys(await ciDuration.run(after.context())), []);
  const before = world(timed(125, 100)).callerChanged("mongodb", ago(200));
  assert.deepEqual(keys(await ciDuration.run(before.context())), [
    "mongodb|ci-duration|main",
  ]);
});

test("the finding names the window start, the ci.yml change here, where naming the oldest kept run fails", async () => {
  const api = world(timed(125, 100)).callerChanged("mongodb", ago(200));
  const result = await ciDuration.run(api.context());
  assert.equal(result.kind, "findings");
  assert.ok(
    result.kind === "findings" &&
      result.findings[0].evidence.includes(`since ${ago(200)}`),
  );
});

test("runs without referenced_workflows decode to an empty list and are judged by duration alone", async () => {
  const [old, current] = [
    run(1, "success", 1),
    run(2, "success", 1, 60, "abc"),
  ];
  assert.deepEqual(workflowRun(old).referencedWorkflows, []);
  assert.deepEqual(workflowRun(current).referencedWorkflows, [
    {
      path: "AntelopeJS/.github/.github/workflows/ci-node.yml@refs/tags/v1",
      sha: "abc",
    },
  ]);
  assert.deepEqual(
    keys(await ciDuration.run(world(timed(125, 100)).context())),
    ["mongodb|ci-duration|main"],
  );
});

test("the median of an even sample is the mean of the two middle values", () => {
  assert.equal(median([10, 40, 20, 30]), 25);
  assert.equal(median([3, 1, 2]), 2);
});

function ownWorkflowRuns(): ReturnType<typeof run>[] {
  return Array.from({ length: 20 }, (_, index) => {
    const body = run(
      index + 1,
      "success",
      1 + index * 6,
      index < 10 ? 125 : 100,
    );
    return isObject(body)
      ? {
          ...body,
          referenced_workflows: [
            {
              path: `AntelopeJS/mongodb/.github/workflows/test.yml@sha${index + 1}`,
              ref: "refs/heads/main",
              sha: `sha${index + 1}`,
            },
          ],
        }
      : body;
  });
}

test("a workflow file of the repository's own, pinned to each run's head, keeps the window and restarts it only when that file changes; a signature that counts its sha never judges", async () => {
  const same = world(ownWorkflowRuns()).fileChanged(
    "mongodb",
    ".github/workflows/test.yml",
    ago(200),
  );
  assert.deepEqual(keys(await ciDuration.run(same.context())), [
    "mongodb|ci-duration|main",
  ]);
  const edited = world(ownWorkflowRuns()).fileChanged(
    "mongodb",
    ".github/workflows/test.yml",
    ago(57),
  );
  assert.deepEqual(keys(await ciDuration.run(edited.context())), []);
});

test("a null referenced_workflows or an entry without sha decodes instead of throwing", () => {
  const body = run(1, "success", 1);
  assert.ok(isObject(body));
  assert.deepEqual(
    workflowRun({ ...body, referenced_workflows: null }).referencedWorkflows,
    [],
  );
  assert.deepEqual(
    workflowRun({
      ...body,
      referenced_workflows: [{ path: "AntelopeJS/.github/x.yml@v1" }],
    }).referencedWorkflows,
    [{ path: "AntelopeJS/.github/x.yml@v1", sha: "" }],
  );
});
