import { isMap, isScalar, isSeq, visit, type YAMLMap } from "yaml";

/** The caller-level gate job older callers carry next to the shared workflow, which already reports `ci / checks`. */
export const LEGACY_AGGREGATOR_ID = "checks";

const JOB_KEYS = new Set([
  "if",
  "needs",
  "runs-on",
  "timeout-minutes",
  "steps",
]);
const STEP_KEYS = new Set(["if", "run", "name"]);
const PLAIN_EXIT = /^exit(?: \d+)?$/;

function isText(value: unknown): value is string {
  return String(value) === value;
}

function onlyKeys(map: YAMLMap, allowed: ReadonlySet<string>): boolean {
  return map.items.every(
    ({ key }) => isScalar(key) && allowed.has(String(key.value)),
  );
}

function needsOnly(job: YAMLMap, id: string): boolean {
  const needs = job.get("needs", true);
  const entries = isSeq(needs) ? needs.items : [needs];
  return (
    entries.length === 1 && isScalar(entries[0]) && entries[0].value === id
  );
}

/**
 * Whether an `if:` expression is built only from `needs.<id>.result` reads, string literals, `contains()`, `always()`
 * and boolean or comparison operators. Reads of any other context, such as `github.event_name`, fail it.
 */
function readsOnlyNeedsResults(expression: string): boolean {
  const rest = expression
    .replace(/'[^']*'/g, "")
    .replace(/needs\.(?:\*|[\w-]+)\.result/g, "")
    .replace(/\b(?:contains|always)\b/g, "");
  return /^[\s(),|&=!${}]*$/.test(rest);
}

function failsOnNeedsResult(step: YAMLMap): boolean {
  if (!onlyKeys(step, STEP_KEYS)) return false;
  const run = step.get("run");
  const condition = step.get("if");
  return (
    isText(run) &&
    PLAIN_EXIT.test(run.trim()) &&
    isText(condition) &&
    /\bneeds\./.test(condition) &&
    readsOnlyNeedsResults(condition)
  );
}

function gatesOnNeedsResults(job: YAMLMap): boolean {
  const steps = job.get("steps", true);
  const condition = job.get("if");
  return (
    isSeq(steps) &&
    steps.items.length > 0 &&
    steps.items.every((step) => isMap(step) && failsOnNeedsResult(step)) &&
    (condition === undefined ||
      (isText(condition) && readsOnlyNeedsResults(condition)))
  );
}

/** Whether any node of the job declares an anchor, which another job's alias could point into. */
function holdsAnchor(job: YAMLMap): boolean {
  let found = false;
  visit(job, (_key, node) => {
    if ((isScalar(node) || isMap(node) || isSeq(node)) && node.anchor) {
      found = true;
      return visit.BREAK;
    }
    return undefined;
  });
  return found;
}

/**
 * Whether `jobs` holds a `checks` job that only re-aggregates the caller: it needs exactly `callerId`, has no `uses`,
 * holds no anchor another job could alias, and each of its steps is a plain `exit` guarded by a condition on `needs`
 * results. It is also the only job besides
 * `keep`, so a repository with its own jobs keeps a gate that covers them.
 */
export function hasRedundantAggregator(
  jobs: YAMLMap,
  callerId: string,
  keep: ReadonlySet<string>,
): boolean {
  const aggregator = jobs.get(LEGACY_AGGREGATOR_ID, true);
  return (
    isMap(aggregator) &&
    !holdsAnchor(aggregator) &&
    onlyKeys(aggregator, JOB_KEYS) &&
    needsOnly(aggregator, callerId) &&
    gatesOnNeedsResults(aggregator) &&
    jobs.items.every(
      ({ key }) =>
        isScalar(key) &&
        (key.value === LEGACY_AGGREGATOR_ID || keep.has(String(key.value))),
    )
  );
}
