import { isMap, type Document, type YAMLMap } from "yaml";

import { handWrittenJobs, isAggregator, type Settled } from "./ci-hand-jobs.ts";
import { VERDICT_JOB_ID } from "./ci-verdict.ts";
import { neededIds, referencedIds } from "./workflow-needs.ts";

/** The `if` an earlier sync gave a caller it made need the hand-written jobs; sync now takes that wiring out. */
export const GATE_CONDITION =
  "${{ !cancelled() && !contains(needs.*.result, 'failure') && !contains(needs.*.result, 'cancelled') }}";

function coveredAdvisory(
  path: string,
  ids: readonly string[],
  by: string,
): string {
  const jobs =
    ids.length === 1
      ? `job ${ids[0]} runs beside the ci caller, so ci / checks passes when it fails. ${by} needs it`
      : `jobs ${ids.join(", ")} run beside the ci caller, so ci / checks passes when one fails. ${by} needs them`;
  return `Gate: ${path} ${jobs} with ci, so require ${by} in the ruleset.`;
}

/** Whether `job` runs under `always()` or `!cancelled()`, so a failed need does not skip it into a passing check. */
function runsAfterFailure(job: YAMLMap): boolean {
  const condition = job.get("if");
  return (
    String(condition) === condition &&
    /^(always\(\)|!\s*cancelled\(\))$/.test(
      condition.replace(/^\$\{\{([\s\S]*)\}\}$/, "$1").trim(),
    )
  );
}

/**
 * The aggregator of `jobs` that needs `callerId` and every one of `ids` and still runs when one of them fails, in file
 * order, else the verdict, which sync has need every job and run unless the run is cancelled.
 */
function coveringAggregator(
  jobs: YAMLMap,
  callerId: string,
  ids: readonly string[],
): string {
  const covering = handWrittenJobs(jobs).find(({ job }) => {
    const needed = new Set(neededIds(job));
    return (
      isAggregator(job) &&
      runsAfterFailure(job) &&
      needed.has(callerId) &&
      ids.every((id) => needed.has(id))
    );
  });
  return covering?.id ?? VERDICT_JOB_ID;
}

/**
 * Takes out the wiring an earlier sync wrote into a caller that runs under {@link GATE_CONDITION}: each hand-written job
 * the caller needs without reading `needs.<id>` leaves its `needs`, and the caller loses `needs` and `if` once nothing
 * is left. Under that wiring a failed job skips the caller, and a skipped caller of a reusable workflow never reports
 * `ci / checks`, so the merge queue waits for its timeout instead of failing.
 */
function unwire(document: Document, jobs: YAMLMap, caller: YAMLMap): boolean {
  if (String(caller.get("if")).trim() !== GATE_CONDITION) return false;
  const hand = new Set(handWrittenJobs(jobs).map(({ id }) => id));
  const read = new Set(referencedIds(caller));
  const listed = neededIds(caller);
  const kept = listed.filter((id) => !hand.has(id) || read.has(id));
  if (kept.length === listed.length) return false;
  if (kept.length > 0)
    caller.set("needs", document.createNode(kept, { flow: true }));
  else {
    caller.delete("needs");
    caller.delete("if");
  }
  return true;
}

/**
 * Settles the gate of the workflow at `path`. A caller an earlier sync wired is unwired ({@link unwire}), so `ci / checks`
 * reports without waiting for an e2e suite. The verdict sync writes, or an aggregator of the file, needs every job with
 * the caller, and one advisory names that aggregator as the check to require for the hand-written jobs beside the
 * caller that are not aggregators.
 */
export function settleGate(
  document: Document,
  jobs: YAMLMap,
  callerId: string,
  path: string,
): Settled {
  const caller = jobs.get(callerId, true);
  if (!isMap(caller)) return { changed: false, advisories: [] };
  const changed = unwire(document, jobs, caller);
  const listed = new Set(neededIds(caller));
  const beside = handWrittenJobs(jobs).flatMap(({ id, job }) =>
    id === VERDICT_JOB_ID || listed.has(id) || isAggregator(job) ? [] : [id],
  );
  if (!beside.length) return { changed, advisories: [] };
  return {
    changed,
    advisories: [
      coveredAdvisory(path, beside, coveringAggregator(jobs, callerId, beside)),
    ],
  };
}
