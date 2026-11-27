import { parseDocument } from "yaml";

import { ACTION_PINS, BLACKSMITH_RUNNERS } from "../ci-hand-jobs.ts";
import { isText } from "../workflow-needs.ts";

interface AuditJob {
  uses?: string;
  needs?: string | string[];
  "runs-on"?: string | string[];
  strategy?: { matrix?: { os?: string[] } };
  steps?: { uses?: string }[];
}

interface AuditWorkflow {
  on?: string | string[] | object;
  concurrency?: { "cancel-in-progress"?: string | boolean };
  jobs?: Record<string, AuditJob>;
}

const CANCEL = "${{ github.event_name == 'pull_request' }}";

function needsOf(job: AuditJob | undefined): string[] {
  return [job?.needs ?? []].flat();
}

function reaches(
  jobs: ReadonlyMap<string, AuditJob>,
  from: string,
  target: string,
): boolean {
  const seen = new Set<string>();
  const queue = [from];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of needsOf(jobs.get(id))) {
      if (next === target) return true;
      queue.push(next);
    }
  }
  return false;
}

function runnersOf(job: AuditJob): string[] {
  const runsOn = [job["runs-on"] ?? "none"].flat();
  return runsOn.includes("${{ matrix.os }}") && job.strategy?.matrix?.os
    ? job.strategy.matrix.os
    : runsOn;
}

function triggersOf({ on }: AuditWorkflow): string[] {
  if (on === undefined) return [];
  return Array.isArray(on) ? on : isText(on) ? [on] : Object.keys(on);
}

function isAggregator(job: AuditJob): boolean {
  return (
    job.needs !== undefined &&
    (job.steps ?? []).every((step) => step.uses === undefined)
  );
}

function actionFinding(id: string, uses: string | undefined): string[] {
  if (uses === undefined) return [];
  const at = uses.indexOf("@");
  const pin = ACTION_PINS.get(uses.slice(0, at));
  return pin !== undefined && uses.slice(at + 1) !== pin.sha
    ? [`action: ${id} uses ${uses}`]
    : [];
}

function jobFindings(
  id: string,
  job: AuditJob,
  jobs: ReadonlyMap<string, AuditJob>,
): string[] {
  const allowed: readonly string[] = Object.values(BLACKSMITH_RUNNERS);
  const covered = [...jobs.values()].some(
    (other) =>
      other !== job &&
      isAggregator(other) &&
      needsOf(other).includes("ci") &&
      needsOf(other).includes(id),
  );
  const besideCaller =
    id !== "verdict" &&
    !covered &&
    !needsOf(jobs.get("ci")).includes(id) &&
    !reaches(jobs, id, "ci");
  return [
    ...runnersOf(job)
      .filter((runner) => !allowed.includes(runner))
      .map((runner) => `runner: ${id} runs on ${runner}`),
    ...(job.steps ?? []).flatMap(({ uses }) => actionFinding(id, uses)),
    ...(besideCaller ? [`gate: ${id} runs beside ci`] : []),
  ];
}

/**
 * The runner, action-version, concurrency and gate findings the org's /ci audit would report on the workflow `text`, one
 * line each: a hand-written job off the two Blacksmith runners or on an unpinned action, a pull request workflow with a
 * hand-written job and no `cancel-in-progress` expression, and a hand-written job beside the `ci` caller that the caller
 * does not need, that does not need the caller, and that no aggregator needs with the caller.
 */
export function ciFindings(text: string): string[] {
  const workflow: AuditWorkflow = parseDocument(text).toJS();
  const jobs = new Map(Object.entries(workflow.jobs ?? {}));
  const hand = [...jobs].filter(([, job]) => job.uses === undefined);
  const found = hand.flatMap(([id, job]) => jobFindings(id, job, jobs));
  const cancelled = workflow.concurrency?.["cancel-in-progress"] === CANCEL;
  if (
    triggersOf(workflow).includes("pull_request") &&
    hand.some(([, job]) => !isAggregator(job)) &&
    !cancelled
  )
    found.push(
      "concurrency: cancel-in-progress is not the pull_request expression",
    );
  return found;
}
