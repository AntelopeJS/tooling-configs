import { perRepo, type Check } from "../check.ts";
import { GardenContext, ORG, type GardenRepo } from "../context.ts";
import type { WorkflowRun } from "../decode.ts";
import { finding, type Finding } from "../types.ts";

const DAY = 24 * 60 * 60 * 1000;
const WORKFLOW = "ci.yml";
const CALLER = `.github/workflows/${WORKFLOW}`;
const RECENT_RUNS = 10;
const MIN_BASELINE = 5;
const RELATIVE_LIMIT = 1.2;
const ABSOLUTE_LIMIT_SECONDS = 60;

const RED = new Set(["failure", "timed_out", "startup_failure"]);

function duration(run: WorkflowRun): number {
  return (run.updatedAt - run.startedAt) / 1000;
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The creation time of the oldest run of the unbroken red streak ending at the newest judged run. */
export function redSince(
  runs: readonly WorkflowRun[],
): WorkflowRun | undefined {
  const judged = runs.filter(
    ({ conclusion }) => conclusion === "success" || RED.has(conclusion ?? ""),
  );
  let oldest: WorkflowRun | undefined;
  for (const run of judged) {
    if (!RED.has(run.conclusion ?? "")) break;
    oldest = run;
  }
  return oldest;
}

async function red(
  context: GardenContext,
  repo: GardenRepo,
): Promise<Finding[]> {
  const branch = await context.targetBranch(repo);
  const runs = await context.workflowRuns(repo, WORKFLOW, branch);
  const since = runs === undefined ? undefined : redSince(runs);
  if (
    since === undefined ||
    context.api.now().getTime() - since.createdAt <= DAY
  )
    return [];
  return [
    finding(
      { repo: repo.name, check: "red-branch", subject: branch },
      `${WORKFLOW} has been red on ${branch} since ${new Date(since.createdAt).toISOString()}: ${since.url}`,
      `${WORKFLOW} is green on ${branch}.`,
    ),
  ];
}

/** A reusable workflow path without its `@ref`, e.g. `AntelopeJS/.github/.github/workflows/ci-node.yml`. */
function workflowPath(path: string): string {
  return path.split("@")[0];
}

/** The repository's own file for a workflow it calls from itself; GitHub pins such a call to the run's head commit, so its sha changes on every push. */
function ownFile(repo: GardenRepo, path: string): string | undefined {
  const prefix = `${ORG}/${repo.name}/`;
  const bare = workflowPath(path);
  return bare.startsWith(prefix) ? bare.slice(prefix.length) : undefined;
}

function signature(repo: GardenRepo, run: WorkflowRun): string {
  return [
    ...new Set(
      run.referencedWorkflows
        .filter(({ path }) => ownFile(repo, path) === undefined)
        .map(({ path, sha }) => `${workflowPath(path)} ${sha}`),
    ),
  ]
    .sort()
    .join("\n");
}

/** The newest unbroken streak of runs that called the same other-repository workflows at the same commits as the newest run, and when that streak began if an older run called different ones. */
interface Streak {
  runs: WorkflowRun[];
  since: number | undefined;
}

function sameWorkflows(repo: GardenRepo, runs: readonly WorkflowRun[]): Streak {
  if (runs.length === 0) return { runs: [], since: undefined };
  const current = signature(repo, runs[0]);
  const end = runs.findIndex((run) => signature(repo, run) !== current);
  if (end === -1) return { runs: [...runs], since: undefined };
  return { runs: runs.slice(0, end), since: runs[end - 1].createdAt };
}

/** The newest commit time of the caller and of every workflow file of its own that the newest run called. */
async function callerChange(
  context: GardenContext,
  repo: GardenRepo,
  branch: string,
  newest: WorkflowRun | undefined,
): Promise<number> {
  const files = new Set([
    CALLER,
    ...(newest?.referencedWorkflows ?? [])
      .map(({ path }) => ownFile(repo, path))
      .filter((file) => file !== undefined),
  ]);
  let latest = 0;
  for (const file of files)
    latest = Math.max(
      latest,
      (await context.lastChange(repo, file, branch)) ?? 0,
    );
  return latest;
}

async function slow(
  context: GardenContext,
  repo: GardenRepo,
): Promise<Finding[]> {
  const branch = await context.targetBranch(repo);
  const runs = await context.workflowRuns(repo, WORKFLOW, branch);
  if (runs === undefined) return [];
  const passed = runs.filter((run) => run.conclusion === "success");
  const cutoff = Math.max(
    context.api.now().getTime() - 30 * DAY,
    await callerChange(context, repo, branch, passed[0]),
  );
  const streak = sameWorkflows(
    repo,
    passed.filter((run) => run.createdAt >= cutoff),
  );
  const window = streak.runs;
  const baseline = window.slice(RECENT_RUNS).map(duration);
  if (window.length <= RECENT_RUNS || baseline.length < MIN_BASELINE) return [];
  const recent = median(window.slice(0, RECENT_RUNS).map(duration));
  const usual = median(baseline);
  if (
    recent <= usual * RELATIVE_LIMIT &&
    recent <= usual + ABSOLUTE_LIMIT_SECONDS
  )
    return [];
  const since = new Date(Math.max(cutoff, streak.since ?? 0)).toISOString();
  return [
    finding(
      { repo: repo.name, check: "ci-duration", subject: branch },
      `The median of the last ${RECENT_RUNS} ${WORKFLOW} runs on ${branch} is ${Math.round(recent)} s against ${Math.round(usual)} s over the earlier runs since ${since}, the latest of 30 days ago, the last change to ${CALLER} or a workflow file of this repository it calls, and the last change to the shared workflows it calls.`,
      `The median is within 20% and 60 s of the baseline since the last change to what ${WORKFLOW} runs.`,
    ),
  ];
}

export const redBranch: Check = {
  id: "red-branch",
  async run(context) {
    return perRepo(await context.scope(), (repo) => red(context, repo));
  },
};

/**
 * Flags a repository whose last 10 successful `ci.yml` runs on the target branch take longer than the runs before them.
 * The baseline starts after the last change to what CI runs, so a check added on purpose is accepted: it begins at the
 * newest commit touching `.github/workflows/ci.yml` and at the newest unbroken streak of runs that called the same
 * reusable workflow commits. Too few runs since then is no finding while the baseline refills.
 */
export const ciDuration: Check = {
  id: "ci-duration",
  async run(context) {
    return perRepo(await context.scope(), (repo) => slow(context, repo));
  },
};
