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

/**
 * Makes the required `ci / checks` fail when a hand-written job of the workflow at `path` fails. Every hand-written job
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
  path: string,
): Settled {
  const caller = jobs.get(callerId, true);
  if (!isMap(caller)) return { changed: false, advisories: [] };
  const needs = new Map(
    jobs.items.flatMap(({ key, value }) =>
      isScalar(key) && isMap(value)
        ? [[String(key.value), neededIds(value)]]
        : [],
    ),
  );
  const own = caller.get("if");
  const blocked = own !== undefined && String(own).trim() !== GATE_CONDITION;
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
