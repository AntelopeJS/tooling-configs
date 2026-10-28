import assert from "node:assert/strict";
import test from "node:test";

import { ciDuration, median, redBranch } from "./checks/ci-health.ts";
import { workflowRun } from "./decode.ts";
import { run } from "./helpers/builders.ts";
import { FakeApi, fixture } from "./helpers/fake-api.ts";
import { object, children } from "./json.ts";
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

test("the median of an even sample is the mean of the two middle values", () => {
  assert.equal(median([10, 40, 20, 30]), 25);
  assert.equal(median([3, 1, 2]), 2);
});
