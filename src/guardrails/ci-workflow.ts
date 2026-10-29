import {
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type Document,
  type Node,
  type YAMLMap,
} from "yaml";

export const CI_PATH = ".github/workflows/ci.yml";
export const MUTATION_PATH = ".github/workflows/mutation.yml";
export const CI_JOB_ID = "ci";
/** The status context GitHub derives from the caller job id and the shared workflow's `checks` job. */
export const CI_CONTEXT = `${CI_JOB_ID} / checks`;
const RENOVATE_SYNC_JOB_ID = "renovate-sync";
export const CI_NODE_REF =
  "AntelopeJS/.github/.github/workflows/ci-node.yml@v1";
export const CI_RENOVATE_SYNC_REF =
  "AntelopeJS/.github/.github/workflows/ci-renovate-sync.yml@v1";
const MUTATION_REF = "AntelopeJS/.github/.github/workflows/mutation.yml@v1";

export const CI_CALLER = `name: ci

on:
  push:
    branches:
      - main
      - next
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  ${CI_JOB_ID}:
    permissions:
      contents: read
    uses: ${CI_NODE_REF}
    with:
      renovate-sync: false
  ${RENOVATE_SYNC_JOB_ID}:
    if: >-
      github.event_name == 'pull_request'
      && startsWith(github.head_ref, 'renovate/')
      && github.event.pull_request.head.repo.full_name == github.repository
    permissions:
      contents: write
      actions: write
    uses: ${CI_RENOVATE_SYNC_REF}
`;

const WEEK_MINUTES = 7 * 24 * 60;

/** Spreads the weekly runs of different repositories over the week so they do not queue together. */
export function mutationCaller(packageName: string): string {
  let slot = 0;
  for (const character of packageName)
    slot = (slot * 31 + character.charCodeAt(0)) % WEEK_MINUTES;
  const day = Math.floor(slot / 1440) % 7;
  const minute = slot % 60;
  const hour = Math.floor((slot % 1440) / 60);
  return `name: mutation

on:
  schedule:
    - cron: "${minute} ${hour} * * ${day}"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  mutation:
    uses: ${MUTATION_REF}
`;
}

function renameNeeds(document: Document, from: string, to: string): void {
  const jobs = document.get("jobs", true);
  if (!isMap(jobs)) return;
  for (const { value: job } of jobs.items) {
    if (!isMap(job)) continue;
    const needs = job.get("needs", true);
    if (isScalar(needs) && needs.value === from) needs.value = to;
    if (isSeq(needs))
      for (const entry of needs.items)
        if (isScalar(entry) && entry.value === from) entry.value = to;
  }
}

function hasDispatch(document: Document): boolean {
  const trigger = document.get("on", true);
  if (isMap(trigger)) return trigger.has("workflow_dispatch");
  if (isSeq(trigger))
    return trigger.items.some(
      (entry) => isScalar(entry) && entry.value === "workflow_dispatch",
    );
  return isScalar(trigger) && trigger.value === "workflow_dispatch";
}

function addDispatch(document: Document): void {
  const trigger = document.get("on", true);
  if (isMap(trigger)) trigger.set("workflow_dispatch", null);
  else if (isSeq(trigger)) trigger.add("workflow_dispatch");
  else
    document.set(
      "on",
      document.createNode(
        isScalar(trigger) && trigger.value
          ? [String(trigger.value), "workflow_dispatch"]
          : ["workflow_dispatch"],
      ),
    );
}

function grants(job: YAMLMap, expected: Record<string, string>): boolean {
  const granted = job.get("permissions", true);
  const names = Object.keys(expected);
  return (
    isMap(granted) &&
    granted.items.length === names.length &&
    names.every((name) => granted.get(name) === expected[name])
  );
}

function grant(
  document: Document,
  job: YAMLMap,
  expected: Record<string, string>,
): boolean {
  if (grants(job, expected)) return false;
  job.set("permissions", document.createNode(expected));
  return true;
}

function skipsRenovateSync(job: YAMLMap): boolean {
  const inputs = job.get("with", true);
  return isMap(inputs) && inputs.get("renovate-sync") === false;
}

function skipRenovateSync(document: Document, job: YAMLMap): boolean {
  if (skipsRenovateSync(job)) return false;
  const inputs = job.get("with", true);
  if (isMap(inputs)) inputs.set("renovate-sync", false);
  else job.set("with", document.createNode({ "renovate-sync": false }));
  return true;
}

function canonicalSyncJob(): Node {
  const job = parseDocument(CI_CALLER).getIn(
    ["jobs", RENOVATE_SYNC_JOB_ID],
    true,
  );
  if (!isMap(job)) throw new Error("CI_CALLER has no renovate-sync job");
  return job;
}

function ensureSyncJob(
  document: Document,
  jobs: YAMLMap,
  syncCallers: { id: string }[],
): boolean {
  if (!syncCallers.length) {
    jobs.set(RENOVATE_SYNC_JOB_ID, canonicalSyncJob());
    return true;
  }
  let changed = false;
  for (const { id } of syncCallers) {
    const job = jobs.get(id, true);
    if (isMap(job))
      changed =
        grant(document, job, { contents: "write", actions: "write" }) ||
        changed;
  }
  return changed;
}

/**
 * Keeps the shared CI caller on the job id `ci` with no `name`, so the shared workflow reports `ci / checks`,
 * dispatchable and read-only, with the Renovate sync it would otherwise run turned off. The write permissions the sync
 * needs to push and dispatch the caller live on a separate job calling ci-renovate-sync.yml, which is added when missing.
 * No `uses:` ref is ever rewritten. A workflow with no caller job is repository-specific CI and is left as it is.
 */
export function ciWorkflow(
  current: string | undefined,
  callers: { id: string; named: boolean }[],
  syncCallers: { id: string }[],
): string {
  if (current === undefined) return CI_CALLER;
  if (!callers.length) return current;
  const document = parseDocument(current);
  if (document.errors.length)
    throw new Error(
      `${CI_PATH}: ${document.errors.map(({ message }) => message).join("; ")}`,
    );
  const jobs = document.get("jobs", true);
  if (!isMap(jobs)) return current;
  const caller = callers.find(({ id }) => id === CI_JOB_ID) ?? callers[0];
  if (caller.id !== CI_JOB_ID && jobs.has(CI_JOB_ID))
    throw new Error(
      `${CI_PATH}: a job named ${CI_JOB_ID} already exists besides the ${caller.id} job that calls ci-node.yml. Rename or merge them, then rerun antelopejs-sync.`,
    );
  if (!syncCallers.length && jobs.has(RENOVATE_SYNC_JOB_ID))
    throw new Error(
      `${CI_PATH}: a job named ${RENOVATE_SYNC_JOB_ID} already exists and does not call ci-renovate-sync.yml. Rename or merge it, then rerun antelopejs-sync.`,
    );
  const pair = jobs.items.find(
    ({ key }) => isScalar(key) && key.value === caller.id,
  );
  if (!pair || !isMap(pair.value)) return current;
  let changed = false;
  if (caller.named) {
    pair.value.delete("name");
    changed = true;
  }
  if (caller.id !== CI_JOB_ID) {
    if (isScalar(pair.key)) pair.key.value = CI_JOB_ID;
    renameNeeds(document, caller.id, CI_JOB_ID);
    changed = true;
  }
  changed = grant(document, pair.value, { contents: "read" }) || changed;
  changed = skipRenovateSync(document, pair.value) || changed;
  changed = ensureSyncJob(document, jobs, syncCallers) || changed;
  if (!hasDispatch(document)) {
    addDispatch(document);
    changed = true;
  }
  return changed ? document.toString({ lineWidth: 0 }) : current;
}
