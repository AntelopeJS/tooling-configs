import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "./api.ts";
import { staleBranches } from "./checks/branches.ts";
import { ago } from "./helpers/builders.ts";
import { FakeApi } from "./helpers/fake-api.ts";
import type { JsonValue } from "./json.ts";
import { garden } from "./run.ts";
import { found, type CheckResult } from "./types.ts";

const DAY_HOURS = 24;
const REPO = "AntelopeJS/mongodb";

interface Spec {
  name: string;
  days: number;
  protected?: boolean;
}

interface PullSpec {
  number: number;
  head: string;
  sha?: string;
  base?: string;
  merged?: boolean;
  repo?: string | null;
}

function pullBody(spec: PullSpec): JsonValue {
  return {
    number: spec.number,
    title: `PR ${spec.number}`,
    html_url: `https://github.com/${REPO}/pull/${spec.number}`,
    created_at: ago(1),
    user: { login: "dev" },
    head: {
      ref: spec.head,
      sha: spec.sha ?? `sha-${spec.head}`,
      repo: spec.repo === null ? null : { full_name: spec.repo ?? REPO },
    },
    base: { ref: spec.base ?? "main" },
    merged_at: spec.merged === true ? ago(2) : null,
  };
}

/** One in-scope repository with the given branches, each tip committed `days` ago. */
function world(branches: Spec[]): FakeApi {
  const api = new FakeApi().org([{ name: "mongodb" }]);
  api.route(
    `/repos/${REPO}/branches`,
    branches.map((spec) => ({
      name: spec.name,
      protected: spec.protected === true,
      commit: { sha: `sha-${spec.name}` },
    })),
  );
  api.route(`/repos/${REPO}/pulls`, []);
  for (const spec of branches)
    api.route(`/repos/${REPO}/commits/sha-${spec.name}`, {
      commit: { committer: { date: ago(spec.days * DAY_HOURS) } },
    });
  return api;
}

function open(api: FakeApi, pulls: PullSpec[]): FakeApi {
  return api.route(`/repos/${REPO}/pulls?state=open`, pulls.map(pullBody));
}

function closed(api: FakeApi, branch: string, pulls: PullSpec[]): FakeApi {
  return api.route(
    `/repos/${REPO}/pulls?state=closed&head=AntelopeJS:${encodeURIComponent(branch)}`,
    pulls.map(pullBody),
  );
}

function evidence(result: CheckResult): string[] {
  assert.equal(result.kind, "findings");
  return result.kind === "findings"
    ? result.findings.map((entry) => `${entry.subject}: ${entry.evidence}`)
    : [];
}

async function prunes(api: FakeApi): Promise<string[]> {
  return (
    await garden(api, { applyPauses: false, checks: [staleBranches] })
  ).report.prunes.map(({ branch, reason }) => `${branch}: ${reason}`);
}

test("a branch that heads a merged PR, or a closed one, is pruned whatever its age", async () => {
  const api = world([
    { name: "main", days: 1 },
    { name: "feat/merged", days: 1 },
    { name: "fix/closed", days: 2 },
  ]);
  closed(api, "feat/merged", [
    { number: 7, head: "feat/merged", merged: true },
  ]);
  closed(api, "fix/closed", [{ number: 9, head: "fix/closed" }]);
  assert.deepEqual(await prunes(api), [
    "feat/merged: merged PR #7",
    "fix/closed: closed PR #9",
  ]);
});

test("a branch with no PR is pruned at 30 days without a commit and kept at 29", async () => {
  const api = world([
    { name: "old", days: 30 },
    { name: "recent", days: 29 },
  ]);
  assert.deepEqual(await prunes(api), ["old: no commit since 2026-09-28"]);
});

test("the default branch, next and protected branches stay however old they are", async () => {
  const api = world([
    { name: "main", days: 400 },
    { name: "next", days: 400 },
    { name: "release", days: 400, protected: true },
  ]);
  closed(api, "release", [{ number: 3, head: "release", merged: true }]);
  assert.deepEqual(await prunes(api), []);
});

test("a branch that heads or receives an open PR stays even when old or heading a closed PR", async () => {
  const api = world([
    { name: "feat/open", days: 90 },
    { name: "integration", days: 90 },
  ]);
  open(api, [
    { number: 11, head: "feat/open" },
    { number: 12, head: "topic", base: "integration", repo: "someone/fork" },
  ]);
  closed(api, "feat/open", [{ number: 4, head: "feat/open", merged: true }]);
  assert.deepEqual(await prunes(api), []);
});

test("a fork's PR on a namesake ref neither saves nor condemns this repository's branch", async () => {
  const api = world([
    { name: "feature", days: 60 },
    { name: "fresh", days: 1 },
  ]);
  open(api, [{ number: 20, head: "feature", repo: "someone/fork" }]);
  closed(api, "fresh", [
    { number: 21, head: "fresh", repo: "someone/fork", merged: true },
    { number: 22, head: "fresh", repo: null },
  ]);
  assert.deepEqual(await prunes(api), ["feature: no commit since 2026-08-29"]);
});

test("a branch pushed to after its PR closed is judged by its last commit instead", async () => {
  const api = world([
    { name: "reused", days: 2 },
    { name: "abandoned", days: 45 },
  ]);
  closed(api, "reused", [{ number: 5, head: "reused", sha: "older" }]);
  closed(api, "abandoned", [{ number: 6, head: "abandoned", sha: "older" }]);
  assert.deepEqual(await prunes(api), [
    "abandoned: no commit since 2026-09-13",
  ]);
});

test("the check reports one finding per repository listing every stale branch", async () => {
  const api = world([
    { name: "main", days: 1 },
    { name: "a", days: 31 },
    { name: "b", days: 1 },
  ]);
  closed(api, "b", [{ number: 2, head: "b" }]);
  assert.deepEqual(evidence(await staleBranches.run(api.context())), [
    "branches: a (no commit since 2026-09-27), b (closed PR #2)",
  ]);
  const clean = world([{ name: "main", days: 1 }]);
  assert.deepEqual(evidence(await staleBranches.run(clean.context())), []);
});

test("--apply-prunes deletes exactly the listed refs, slashes kept, and a dry run deletes nothing", async () => {
  const setup = () => {
    const api = world([
      { name: "main", days: 1 },
      { name: "feat/x y", days: 1 },
      { name: "keep", days: 1 },
    ]);
    return closed(api, "feat/x y", [{ number: 1, head: "feat/x y" }]);
  };
  const dry = setup();
  await garden(dry, { applyPauses: false, checks: [staleBranches] });
  assert.deepEqual(dry.writes, []);
  const wet = setup();
  await garden(wet, {
    applyPauses: false,
    applyPrunes: true,
    checks: [staleBranches],
  });
  assert.deepEqual(wet.writes, [
    {
      method: "DELETE",
      path: `/repos/${REPO}/git/refs/heads/feat/x%20y`,
    },
  ]);
});

test("a repository whose branches could not be read fails the check and is never pruned", async () => {
  const api = world([{ name: "old", days: 90 }]).route(
    `/repos/${REPO}/pulls?state=open`,
    new ApiError(500, "GET pulls: HTTP 500"),
  );
  const outcome = await garden(api, {
    applyPauses: false,
    applyPrunes: true,
    checks: [staleBranches],
  });
  assert.deepEqual(api.writes, []);
  assert.deepEqual(
    outcome.failures.map(({ check }) => check),
    ["stale-branches"],
  );
});

test("a refused deletion is reported and the remaining prunes still run", async () => {
  const api = world([
    { name: "a-old", days: 90 },
    { name: "b-old", days: 90 },
  ]);
  api.refuse(`/repos/${REPO}/git/refs/heads/a-old`, 422);
  const outcome = await garden(api, {
    applyPauses: false,
    applyPrunes: true,
    checks: [staleBranches],
  });
  assert.deepEqual(
    api.writes.map(({ path }) => path),
    [`/repos/${REPO}/git/refs/heads/b-old`],
  );
  assert.deepEqual(outcome.failures, [
    {
      check: "apply-prunes",
      reason: `mongodb a-old: DELETE /repos/${REPO}/git/refs/heads/a-old: HTTP 422`,
    },
  ]);
});

test("a branch that gains an open PR after the scan is not deleted, because prunes are re-read before deleting", async () => {
  const api = world([{ name: "feat", days: 40 }]);
  const later = {
    id: "later",
    async run() {
      open(api, [{ number: 30, head: "feat" }]);
      return found([]);
    },
  };
  const outcome = await garden(api, {
    applyPauses: false,
    applyPrunes: true,
    checks: [staleBranches, later],
  });
  assert.deepEqual(
    outcome.report.findings.map(({ subject }) => subject),
    ["branches"],
  );
  assert.deepEqual(outcome.report.prunes, []);
  assert.deepEqual(api.writes, []);
});
