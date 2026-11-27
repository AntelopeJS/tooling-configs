import { isMap, isScalar, isSeq, type Document, type YAMLMap } from "yaml";

import { handWrittenJobs, isAggregator, type Settled } from "./ci-hand-jobs.ts";
import { VERDICT_JOB_ID } from "./ci-verdict.ts";
import { neededIds } from "./workflow-needs.ts";

/** The `if` a caller with `needs` runs under: a need skipped on purpose still lets it run, a failed or cancelled one skips it. */
export const GATE_CONDITION =
  "${{ !cancelled() && !contains(needs.*.result, 'failure') && !contains(needs.*.result, 'cancelled') }}";

function reachesJob(
  needs: ReadonlyMap<string, readonly string[]>,
  from: string,
  target: string,
): boolean {
  const seen = new Set<string>();
  const queue = [from];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of needs.get(id) ?? []) {
      if (next === target) return true;
      queue.push(next);
    }
  }
  return false;
}

function insertAt(job: YAMLMap, before: readonly string[]): number {
  const at = job.items.findIndex(
    ({ key }) => isScalar(key) && before.includes(String(key.value)),
  );
  return at === -1 ? 0 : at;
}

function addNeeds(
  document: Document,
  caller: YAMLMap,
  ids: readonly string[],
): void {
  const needs = caller.get("needs", true);
  if (isSeq(needs)) {
    for (const id of ids) needs.add(document.createNode(id));
    return;
  }
  const listed = neededIds(caller);
  const list = document.createNode([...listed, ...ids], { flow: true });
  if (needs === undefined)
    caller.items.splice(
      insertAt(caller, ["permissions", "uses"]),
      0,
      document.createPair("needs", list),
    );
  else caller.set("needs", list);
}

function addCondition(document: Document, caller: YAMLMap): boolean {
  if (caller.has("if")) return false;
  const at = caller.items.findIndex(
    ({ key }) => isScalar(key) && key.value === "needs",
  );
  caller.items.splice(at + 1, 0, document.createPair("if", GATE_CONDITION));
  return true;
}

function unwiredAdvisory(path: string, id: string, why: string): string {
  return `Gate: ${path} job ${id} runs beside the ci caller, so ci / checks passes when it fails. ${why}. Move it into an input of ci-node.yml, or have the ci job need it.`;
}

function coveredAdvisory(
  path: string,
  ids: readonly string[],
  by: string,
  wireable: boolean,
): string {
  const jobs =
    ids.length === 1
      ? `job ${ids[0]} runs beside the ci caller, so ci / checks passes when it fails. ${by} needs it`
      : `jobs ${ids.join(", ")} run beside the ci caller, so ci / checks passes when one fails. ${by} needs them`;
  const opt = wireable
    ? ", or set gateHandJobs in the repository's CI profile to have ci need them"
    : "";
  return `Gate: ${path} ${jobs} with ci, so require ${by} in the ruleset${opt}.`;
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

function needsMap(jobs: YAMLMap): Map<string, string[]> {
  return new Map(
    jobs.items.flatMap(({ key, value }) =>
      isScalar(key) && isMap(value)
        ? [[String(key.value), neededIds(value)]]
        : [],
    ),
  );
}

function hasOwnIf(caller: YAMLMap): boolean {
  const own = caller.get("if");
  return own !== undefined && String(own).trim() !== GATE_CONDITION;
}

/**
 * Leaves the `needs` of `caller` alone and reports, in one advisory, the hand-written jobs of the workflow at `path` that
 * are neither aggregators nor needed by `caller`, with the aggregator that covers them. It offers `gateHandJobs` only
 * when the gate could wire every one of them.
 */
function reportCovered(
  jobs: YAMLMap,
  caller: YAMLMap,
  callerId: string,
  path: string,
): Settled {
  const listed = new Set(neededIds(caller));
  const beside = handWrittenJobs(jobs).flatMap(({ id, job }) =>
    id === VERDICT_JOB_ID || listed.has(id) || isAggregator(job) ? [] : [id],
  );
  if (!beside.length) return { changed: false, advisories: [] };
  const needs = needsMap(jobs);
  const wireable =
    !hasOwnIf(caller) && beside.every((id) => !reachesJob(needs, id, callerId));
  return {
    changed: false,
    advisories: [
      coveredAdvisory(
        path,
        beside,
        coveringAggregator(jobs, callerId, beside),
        wireable,
      ),
    ],
  };
}

/**
 * Makes the required `ci / checks` fail when a hand-written job of the workflow at `path` fails, when `gate` is on.
 * With it off, the `needs` of the caller stay, since the verdict sync writes, or an aggregator of the file, needs every
 * job with the caller, and one advisory names that aggregator as the check to require. Every hand-written job
 * that does not need the `caller` directly or through other jobs, and is not the verdict, joins the `needs` of `caller`,
 * in file order, so a failing one skips the caller and its check never passes. A caller with `needs` runs under
 * {@link GATE_CONDITION}, so a job skipped on purpose does not block it. A caller that has another `if` is left as it is,
 * and so is the gate: a job that cannot be wired, because it needs the caller or the caller has its own `if`, gets an
 * advisory unless it is an aggregator.
 */
export function wireGate(
  document: Document,
  jobs: YAMLMap,
  callerId: string,
  { gate, path }: { gate: boolean; path: string },
): Settled {
  const caller = jobs.get(callerId, true);
  if (!isMap(caller)) return { changed: false, advisories: [] };
  if (!gate) return reportCovered(jobs, caller, callerId, path);
  const needs = needsMap(jobs);
  const blocked = hasOwnIf(caller);
  const listed = new Set(neededIds(caller));
  const wire: string[] = [];
  const advisories: string[] = [];
  for (const { id, job } of handWrittenJobs(jobs)) {
    if (id === VERDICT_JOB_ID || listed.has(id)) continue;
    const reaches = reachesJob(needs, id, callerId);
    if (!reaches && !blocked) wire.push(id);
    else if (!isAggregator(job))
      advisories.push(
        unwiredAdvisory(
          path,
          id,
          reaches
            ? `It needs ${callerId}, so ${callerId} cannot need it`
            : `${callerId} has its own if, which sync does not rewrite`,
        ),
      );
  }
  if (wire.length) addNeeds(document, caller, wire);
  const conditioned =
    !blocked && caller.has("needs") && addCondition(document, caller);
  return { changed: wire.length > 0 || conditioned, advisories };
}
