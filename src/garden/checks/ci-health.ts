import { perRepo, type Check } from "../check.ts";
import { GardenContext, type GardenRepo } from "../context.ts";
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

function signature(run: WorkflowRun): string {
  return [
    ...new Set(
      run.referencedWorkflows.map(
        ({ path, sha }) => `${path.split("@")[0]} ${sha}`,
      ),
    ),
  ]
    .sort()
    .join("\n");
}

/** The newest unbroken streak of runs that called the same reusable workflows at the same commits as the newest run. */
function sameWorkflows(runs: readonly WorkflowRun[]): WorkflowRun[] {
  if (runs.length === 0) return [];
  const current = signature(runs[0]);
  const end = runs.findIndex((run) => signature(run) !== current);
  return runs.slice(0, end === -1 ? runs.length : end);
}

async function slow(
  context: GardenContext,
  repo: GardenRepo,
): Promise<Finding[]> {
  const branch = await context.targetBranch(repo);
  const runs = await context.workflowRuns(repo, WORKFLOW, branch);
  if (runs === undefined) return [];
  const callerChange = await context.lastChange(repo, CALLER, branch);
  const start = Math.max(
    context.api.now().getTime() - 30 * DAY,
    callerChange ?? 0,
  );
  const window = sameWorkflows(
    runs.filter(
      (run) => run.conclusion === "success" && run.createdAt >= start,
    ),
  );
  const baseline = window.slice(RECENT_RUNS).map(duration);
  if (window.length <= RECENT_RUNS || baseline.length < MIN_BASELINE) return [];
  const recent = median(window.slice(0, RECENT_RUNS).map(duration));
  const usual = median(baseline);
  if (
    recent <= usual * RELATIVE_LIMIT &&
    recent <= usual + ABSOLUTE_LIMIT_SECONDS
  )
    return [];
  const since = new Date(window[window.length - 1].createdAt).toISOString();
  return [
    finding(
      { repo: repo.name, check: "ci-duration", subject: branch },
      `The median of the last ${RECENT_RUNS} ${WORKFLOW} runs on ${branch} is ${Math.round(recent)} s against ${Math.round(usual)} s over the earlier runs since ${since}, the later of 30 days ago and the last change to ${CALLER} or the workflows it calls.`,
      `The median is within 20% and 60 s of the baseline since the last change to ${CALLER} or the workflows it calls.`,
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
