import {
  isMap,
  isNode,
  isScalar,
  parseDocument,
  type Document,
  type Node,
  type YAMLMap,
} from "yaml";

import {
  hasRedundantAggregator,
  LEGACY_AGGREGATOR_ID,
} from "./ci-aggregator.ts";
import { setCallersDocsFiles, type DocsFilesPlan } from "./ci-docs-files.ts";
import { sharedWorkflow } from "./workflow.ts";
import { renameJobReferences, staleNeeds } from "./workflow-needs.ts";
import { restoreEmptyValueComments } from "./yaml-comments.ts";
import { blockOverflowingFlow } from "./yaml-flow.ts";

export const CI_PATH = ".github/workflows/ci.yml";
export const CI_JOB_ID = "ci";
/** The status context GitHub derives from the caller job id and the shared workflow's `checks` job. */
export const CI_CONTEXT = `${CI_JOB_ID} / checks`;
const RENOVATE_SYNC_JOB_ID = "renovate-sync";
const RENOVATE_SYNC_GRANTS = {
  contents: "write",
  actions: "write",
  statuses: "write",
};
export const CI_NODE_REF = sharedWorkflow("ci-node.yml");
export const CI_RENOVATE_SYNC_REF = sharedWorkflow("ci-renovate-sync.yml");
const NOTION_TOKEN = "${{ secrets.NOTION_TOKEN }}";

/** How a repository's caller departs from the shared triggers and inputs. */
export interface CiProfile {
  /** The branch that collects changes before `main` and whose pushes run the full set, `develop` in cloud; absent on trunk, where the merge queue gates `main`. */
  integrationBranch?: string;
  /** Whether the caller may keep the `windows: true` and `windows-pull-requests` inputs that ask ci-node.yml for Windows on pull requests. */
  windowsOnPullRequests: boolean;
  /** Whether ci-node.yml may run checks and tests in one job; `false` for a repository whose tests take minutes, so its caller passes `single-job: false`. */
  singleJob: boolean;
}

const DEFAULT_PROFILE: CiProfile = {
  windowsOnPullRequests: false,
  singleJob: true,
};

const PROFILES = new Map<string, Partial<CiProfile>>([
  ["@antelopejs/core", { windowsOnPullRequests: true, singleJob: false }],
  ["cloud-sdk-workspace", { windowsOnPullRequests: true }],
  ["@antelopejs-private/cloud", { integrationBranch: "develop" }],
  ["dms-workspace", { singleJob: false }],
  ["@antelopejs/dms-frontend", { singleJob: false }],
  ["@antelopejs/mongodb", { singleJob: false }],
  ["@antelopejs/dms-assistant", { singleJob: false }],
]);

/** The CI profile of the repository whose package.json is named `name`; the default for any other name. */
export function ciProfile(name: string | undefined): CiProfile {
  return { ...DEFAULT_PROFILE, ...PROFILES.get(name ?? "") };
}

/**
 * The triggers of the trunk-based CI: ci-node.yml picks the tier from the event, so a caller declares pull requests
 * (draft to ready included), the merge queue's `merge_group` run that gates every merge into `main`, pushes to `main`,
 * a nightly run and manual dispatch. A label change reruns, so `ci:full` applies.
 */
export const ciTriggers = `on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, labeled, unlabeled]
  merge_group:
  push:
    branches: [main]
  schedule:
    - cron: "17 2 * * *"
  workflow_dispatch:
`;

/** The triggers of a repository with an integration branch: pull requests, pushes to `branch`, a nightly run and manual dispatch; a push to `main` runs nothing. */
function integrationTriggers(branch: string): string {
  return `on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  push:
    branches: [${branch}]
  schedule:
    - cron: "17 2 * * *"
  workflow_dispatch:
`;
}

function triggersFor({ integrationBranch }: CiProfile): string {
  return integrationBranch === undefined
    ? ciTriggers
    : integrationTriggers(integrationBranch);
}

export const CI_CALLER = `name: ci

${ciTriggers}
permissions:
  contents: read

jobs:
  ${CI_JOB_ID}:
    permissions:
      contents: read
    uses: ${CI_NODE_REF}
    with:
      renovate-sync: false
      test-job: true
    secrets:
      NOTION_TOKEN: ${NOTION_TOKEN}
  ${RENOVATE_SYNC_JOB_ID}:
    if: >-
      github.event_name == 'pull_request'
      && startsWith(github.head_ref, 'renovate/')
      && github.event.pull_request.head.repo.full_name == github.repository
    permissions:
      contents: write
      actions: write
      statuses: write
    uses: ${CI_RENOVATE_SYNC_REF}
`;

function triggersOf(document: Document): string {
  const node = document.get("on", true);
  return JSON.stringify(isNode(node) ? node.toJS(document) : node);
}

function setTriggers(document: Document, profile: CiProfile): boolean {
  const desired = parseDocument(triggersFor(profile));
  if (triggersOf(document) === triggersOf(desired)) return false;
  document.set("on", desired.get("on", true));
  const root = document.contents;
  if (!isMap(root)) return true;
  const at = root.items.findIndex(
    ({ key }) => isScalar(key) && key.value === "on",
  );
  const after = root.items[at + 1]?.key;
  if (isNode(after)) after.spaceBefore = true;
  return true;
}

/** Whether the caller asks for Windows beyond the default: any `windows` value but an opt-out `false`, or Windows on pull requests. */
function asksForWindows(inputs: YAMLMap, key: string): boolean {
  return (
    key === "windows-pull-requests" ||
    (key === "windows" && inputs.get("windows") !== false)
  );
}

function dropWindows(
  jobs: YAMLMap,
  callers: readonly { id: string }[],
  profile: CiProfile,
): boolean {
  if (profile.windowsOnPullRequests) return false;
  let changed = false;
  for (const { id } of callers) {
    const inputs = jobs.getIn([id, "with"], true);
    if (!isMap(inputs)) continue;
    const before = inputs.items.length;
    inputs.items = inputs.items.filter(
      ({ key }) =>
        !(isScalar(key) && asksForWindows(inputs, String(key.value))),
    );
    if (inputs.items.length === before) continue;
    if (!inputs.items.length) jobs.deleteIn([id, "with"]);
    changed = true;
  }
  return changed;
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

function pinRefs(
  jobs: YAMLMap,
  callers: readonly { id: string }[],
  ref: string,
): boolean {
  let changed = false;
  for (const { id } of callers) {
    const uses = jobs.getIn([id, "uses"], true);
    if (!isScalar(uses) || uses.value === ref) continue;
    uses.value = ref;
    changed = true;
  }
  return changed;
}

/** Points every caller at the shared tag and drops the Windows inputs `profile` does not allow. */
function pinCallerRefs(
  jobs: YAMLMap,
  callers: readonly { id: string }[],
  syncCallers: readonly { id: string }[],
  profile: CiProfile,
): boolean {
  const windows = dropWindows(jobs, callers, profile);
  const node = pinRefs(jobs, callers, CI_NODE_REF);
  return pinRefs(jobs, syncCallers, CI_RENOVATE_SYNC_REF) || node || windows;
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

function setTestJob(
  document: Document,
  job: YAMLMap,
  placeholderTests: boolean,
): boolean {
  const inputs = job.get("with", true);
  if (isMap(inputs)) {
    if (!inputs.has("test-job")) {
      inputs.set("test-job", !placeholderTests);
      return true;
    }
    if (!placeholderTests || inputs.get("test-job") === false) return false;
    inputs.set("test-job", false);
    return true;
  }
  job.set("with", document.createNode({ "test-job": !placeholderTests }));
  return true;
}

function setSingleJob(
  document: Document,
  job: YAMLMap,
  profile: CiProfile,
): boolean {
  if (profile.singleJob) return false;
  const inputs = job.get("with", true);
  if (isMap(inputs)) {
    if (inputs.get("single-job") === false) return false;
    inputs.set("single-job", false);
  } else job.set("with", document.createNode({ "single-job": false }));
  return true;
}

/** Passes ci-node.yml the NOTION_TOKEN it files flaky-test tasks with; a caller with `secrets: inherit` already does. */
function passNotionToken(document: Document, job: YAMLMap): boolean {
  const secrets = job.get("secrets", true);
  if (isScalar(secrets) && secrets.value === "inherit") return false;
  if (isMap(secrets)) {
    if (secrets.get("NOTION_TOKEN") === NOTION_TOKEN) return false;
    secrets.set("NOTION_TOKEN", NOTION_TOKEN);
  } else job.set("secrets", document.createNode({ NOTION_TOKEN }));
  return true;
}

function setCallerInputs(
  document: Document,
  job: YAMLMap,
  placeholderTests: boolean,
  profile: CiProfile,
): boolean {
  const testJob = setTestJob(document, job, placeholderTests);
  const singleJob = setSingleJob(document, job, profile);
  return passNotionToken(document, job) || singleJob || testJob;
}

/** The caller sync writes into a repository without one, its test job off when the `test` script is a placeholder. */
function newCaller(placeholderTests: boolean): string {
  return placeholderTests
    ? CI_CALLER.replace("test-job: true", "test-job: false")
    : CI_CALLER;
}

/**
 * Whether a `test` script only stands in for tests: made only of `echo` and
 * `exit 0` commands, such as `echo 'No tests defined'`. A missing script is
 * not a placeholder, since the shared test job may run tests another way. Such a
 * repository gets `test-job: false`, since a test job would only spend runner
 * time printing it.
 */
export function placeholderTestScript(script: string | undefined): boolean {
  if (script === undefined) return false;
  const commands = script
    .split(/&&|\|\||;/)
    .map((command) => command.trim())
    .filter(Boolean);
  return (
    commands.length > 0 &&
    commands.every(
      (command) => /^echo(\s|$)/.test(command) || /^exit\s+0$/.test(command),
    )
  );
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
    jobs.add(document.createPair(RENOVATE_SYNC_JOB_ID, canonicalSyncJob()));
    return true;
  }
  let changed = false;
  for (const { id } of syncCallers) {
    const job = jobs.get(id, true);
    if (isMap(job))
      changed = grant(document, job, RENOVATE_SYNC_GRANTS) || changed;
  }
  return changed;
}

function assertNoClash(
  jobs: YAMLMap,
  callerId: string,
  hasSyncCaller: boolean,
): void {
  if (callerId !== CI_JOB_ID && jobs.has(CI_JOB_ID))
    throw new Error(
      `${CI_PATH}: a job named ${CI_JOB_ID} already exists besides the ${callerId} job that calls ci-node.yml. Rename or merge them, then rerun antelopejs-sync.`,
    );
  if (hasSyncCaller || !jobs.has(RENOVATE_SYNC_JOB_ID)) return;
  throw new Error(
    callerId === RENOVATE_SYNC_JOB_ID
      ? `${CI_PATH}: the job ${RENOVATE_SYNC_JOB_ID} calls ci-node.yml, but that id is reserved for the job calling ci-renovate-sync.yml. Rename it, then rerun antelopejs-sync.`
      : `${CI_PATH}: a job named ${RENOVATE_SYNC_JOB_ID} already exists and does not call ci-renovate-sync.yml. Rename or merge it, then rerun antelopejs-sync.`,
  );
}

function dropRedundantAggregator(
  jobs: YAMLMap,
  syncCallers: { id: string }[],
): string[] {
  const keep = new Set([
    CI_JOB_ID,
    ...(syncCallers.length
      ? syncCallers.map(({ id }) => id)
      : [RENOVATE_SYNC_JOB_ID]),
  ]);
  if (!hasRedundantAggregator(jobs, CI_JOB_ID, keep)) return [];
  jobs.delete(LEGACY_AGGREGATOR_ID);
  return [LEGACY_AGGREGATOR_ID];
}

function renameCaller(
  document: Document,
  { key, value }: { key: unknown; value: YAMLMap },
  caller: { id: string; named: boolean },
): boolean {
  if (caller.named) value.delete("name");
  if (caller.id === CI_JOB_ID) return caller.named;
  if (isScalar(key)) key.value = CI_JOB_ID;
  renameJobReferences(document, caller.id, CI_JOB_ID);
  return true;
}

/** What sync knows of the repository when it plans its caller. */
export interface CiPlan {
  docsFiles?: DocsFilesPlan;
  placeholderTests?: boolean;
  profile?: CiProfile;
}

/** What package.json tells the caller: whether its `test` script only stands in for tests, and the profile its name selects. */
export function callerPlan(manifest: {
  name?: string;
  scripts?: Record<string, string>;
}): CiPlan {
  return {
    placeholderTests: placeholderTestScript(manifest.scripts?.test),
    profile: ciProfile(manifest.name),
  };
}

/**
 * Keeps the shared CI caller on the job id `ci` with no `name`, so the shared workflow reports `ci / checks`,
 * dispatchable and read-only, with the Renovate sync it would otherwise run turned off. The write permissions the sync
 * needs to push and dispatch the caller live on a separate job calling ci-renovate-sync.yml, which is added when missing.
 * A caller without a `test-job` input gets `test-job: true`, which runs the tests in their own job, or `false` when
 * `placeholderTests` says the `test` script only stands in for tests; that case also turns an existing `true` off. Any
 * other explicit value is left as the repository set it. The caller passes the `NOTION_TOKEN` secret, which ci-node.yml
 * files a flaky-test task with, and `single-job: false` when `profile.singleJob` is off.
 * A `checks` job that only re-aggregates the caller (`needs: [ci]`, steps that `exit` on `needs` results) is removed
 * when the workflow has no other job besides the caller and the Renovate sync, since the shared workflow already
 * reports `ci / checks` and each `needs` hop adds to the critical path. A gate that also covers repository-specific
 * jobs is kept.
 * The workflow declares exactly the `ciTriggers` of the trunk-based CI: pull requests, the merge queue, pushes to `main`, the nightly run and dispatch;
 * a profile with an `integrationBranch` pushes on that branch instead and has no merge queue. Unless
 * `profile.windowsOnPullRequests` lets the repository ask for Windows on pull requests, no caller passes
 * `windows-pull-requests` or a `windows` other than the opt-out `false`. Sync writes neither input.
 * Every job calling ci-node.yml or ci-renovate-sync.yml calls it at `CI_NODE_REF` or `CI_RENOVATE_SYNC_REF`, whatever
 * ref it had. A workflow with no caller job is repository-specific CI and is left as it is.
 * When `docsFiles` computes paths, every caller's `docs-files` input lists them first, then keeps its hand-listed paths
 * that still exist, so sync never drops coverage.
 */
export function ciWorkflow(
  current: string | undefined,
  callers: { id: string; named: boolean }[],
  syncCallers: { id: string }[],
  plan: CiPlan = {},
): string {
  const { docsFiles, profile = DEFAULT_PROFILE } = plan;
  const placeholderTests = plan.placeholderTests === true;
  if (current === undefined)
    return ciWorkflow(
      newCaller(placeholderTests),
      [{ id: CI_JOB_ID, named: false }],
      [{ id: RENOVATE_SYNC_JOB_ID }],
      plan,
    );
  if (!callers.length) return current;
  const document = parseDocument(current);
  if (document.errors.length)
    throw new Error(
      `${CI_PATH}: ${document.errors.map(({ message }) => message).join("; ")}`,
    );
  const jobs = document.get("jobs", true);
  if (!isMap(jobs)) return current;
  restoreEmptyValueComments(document, current);
  const caller = callers.find(({ id }) => id === CI_JOB_ID) ?? callers[0];
  assertNoClash(jobs, caller.id, syncCallers.length > 0);
  const pair = jobs.items.find(
    ({ key }) => isScalar(key) && key.value === caller.id,
  );
  if (!pair || !isMap(pair.value)) return current;
  let changed = setCallersDocsFiles(document, jobs, callers, docsFiles);
  changed = pinCallerRefs(jobs, callers, syncCallers, profile) || changed;
  changed =
    renameCaller(document, { key: pair.key, value: pair.value }, caller) ||
    changed;
  changed = grant(document, pair.value, { contents: "read" }) || changed;
  changed = skipRenovateSync(document, pair.value) || changed;
  changed =
    setCallerInputs(document, pair.value, placeholderTests, profile) || changed;
  changed = ensureSyncJob(document, jobs, syncCallers) || changed;
  const removed = dropRedundantAggregator(jobs, syncCallers);
  changed = removed.length > 0 || changed;
  changed = setTriggers(document, profile) || changed;
  const stale = staleNeeds(document, CI_PATH, removed);
  if (stale.length) throw new Error(stale.join("\n"));
  if (!changed) return current;
  blockOverflowingFlow(document);
  return document.toString({ lineWidth: 0, flowCollectionPadding: false });
}
