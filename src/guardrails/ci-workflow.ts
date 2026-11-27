import {
  isMap,
  isNode,
  isScalar,
  parseDocument,
  type Document,
  type Node,
  type YAMLMap,
} from "yaml";

import { affectedTestsFit } from "./affected-tests.ts";
import {
  hasRedundantAggregator,
  LEGACY_AGGREGATOR_ID,
} from "./ci-aggregator.ts";
import { setCallersDocsFiles, type DocsFilesPlan } from "./ci-docs-files.ts";
import { formalPlan, type FormalPlan } from "./ci-formal.ts";
import { settleHandWritten } from "./ci-hand-written.ts";
import { dropWindows } from "./ci-windows.ts";
import {
  assertNothingNeedsVerdict,
  DISPATCH_TRIGGER,
  NIGHTLY_INPUT,
  setVerdict,
  VERDICT_JOB_ID,
  verdictJob,
} from "./ci-verdict.ts";
import { sharedWorkflow } from "./workflow.ts";
import { renameJobReferences, staleNeeds } from "./workflow-needs.ts";
import { restoreEmptyValueComments } from "./yaml-comments.ts";
import { blockOverflowingFlow } from "./yaml-flow.ts";

export const CI_PATH = ".github/workflows/ci.yml";
export const CI_JOB_ID = "ci";
/** The status context GitHub derives from the caller job id and the shared workflow's `checks` job. */
export const CI_CONTEXT = `${CI_JOB_ID} / checks`;
/**
 * The status contexts a default branch may require, the caller's unnamed `verdict` job first. `ci / checks` stays
 * accepted until the Required CI ruleset requires `verdict`.
 */
export const REQUIRED_CONTEXTS = [VERDICT_JOB_ID, CI_CONTEXT] as const;
/** {@link REQUIRED_CONTEXTS} as prose, for findings and messages. */
export const REQUIRED_CONTEXTS_TEXT = REQUIRED_CONTEXTS.join(" or ");
const RENOVATE_SYNC_JOB_ID = "renovate-sync";
const RENOVATE_SYNC_GRANTS = {
  contents: "write",
  actions: "write",
  statuses: "write",
};
export const CI_NODE_REF = sharedWorkflow("ci-node.yml");
export const CI_RENOVATE_SYNC_REF = sharedWorkflow("ci-renovate-sync.yml");

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
${DISPATCH_TRIGGER}`;

/** The triggers of a repository with an integration branch: pull requests (label changes included, so `ci:full` applies), `merge_group`, pushes to `branch`, a nightly run and manual dispatch; a push to `main` runs nothing. */
function integrationTriggers(branch: string): string {
  return `on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, labeled, unlabeled]
  merge_group:
  push:
    branches: [${branch}]
  schedule:
    - cron: "17 2 * * *"
${DISPATCH_TRIGGER}`;
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
      nightly: ${NIGHTLY_INPUT}
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
${verdictJob([CI_JOB_ID, RENOVATE_SYNC_JOB_ID])}`;

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
  const windows = !profile.windowsOnPullRequests && dropWindows(jobs, callers);
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

function setInput(
  document: Document,
  job: YAMLMap,
  key: string,
  value: boolean | string,
): boolean {
  const inputs = job.get("with", true);
  if (isMap(inputs)) {
    if (inputs.get(key) === value) return false;
    inputs.set(key, value);
  } else job.set("with", document.createNode({ [key]: value }));
  return true;
}

/** Stops the caller passing the `NOTION_TOKEN` ci-node.yml ignores, whatever its value, and drops a `secrets` map that is left empty; `secrets: inherit` stays. */
function dropNotionToken(job: YAMLMap): boolean {
  const secrets = job.get("secrets", true);
  if (!isMap(secrets) || !secrets.delete("NOTION_TOKEN")) return false;
  if (secrets.items.length === 0) job.delete("secrets");
  return true;
}

function setCallerInputs(
  document: Document,
  job: YAMLMap,
  placeholderTests: boolean,
  { profile = DEFAULT_PROFILE, affectedTests }: CiPlan,
): boolean {
  const testJob = setTestJob(document, job, placeholderTests);
  const singleJob =
    !profile.singleJob && setInput(document, job, "single-job", false);
  const affected =
    affectedTests === true && setInput(document, job, "affected-tests", true);
  const nightly = setInput(document, job, "nightly", NIGHTLY_INPUT);
  return dropNotionToken(job) || singleJob || affected || testJob || nightly;
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
    VERDICT_JOB_ID,
    ...(syncCallers.length
      ? syncCallers.map(({ id }) => id)
      : [RENOVATE_SYNC_JOB_ID]),
  ]);
  if (!hasRedundantAggregator(jobs, CI_JOB_ID, keep)) return [];
  jobs.delete(LEGACY_AGGREGATOR_ID);
  return [LEGACY_AGGREGATOR_ID];
}

/** Adds a missing Renovate sync job and drops the redundant aggregator, then has the verdict need every job left. */
function settleJobs(
  document: Document,
  jobs: YAMLMap,
  syncCallers: { id: string }[],
) {
  const added = ensureSyncJob(document, jobs, syncCallers);
  const removed = dropRedundantAggregator(jobs, syncCallers);
  const verdict = setVerdict(document, jobs);
  return { changed: added || removed.length > 0 || verdict, removed };
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

/** The ci.yml text sync wants, and the findings it only reports. */
export interface CiWorkflowResult {
  content: string;
  advisories: string[];
}

/** What sync knows of the repository when it plans its caller. */
export interface CiPlan {
  docsFiles?: DocsFilesPlan;
  placeholderTests?: boolean;
  profile?: CiProfile;
  /** Whether the caller passes `affected-tests: true`, so ci-node.yml runs only the affected tests on a pull request. */
  affectedTests?: boolean;
  /** The repository's formal skills; absent, the workflow's formal jobs and `formal-checks` input stay as they are. */
  formal?: FormalPlan;
}

/** What the repository at `root` tells the caller: whether its `test` script only stands in for tests, the profile its name selects, whether its affected tests fit, and its formal check skills. */
export function callerPlan(
  root: string,
  manifest: { name?: string; scripts?: Record<string, string> },
): CiPlan {
  return {
    placeholderTests: placeholderTestScript(manifest.scripts?.test),
    profile: ciProfile(manifest.name),
    affectedTests: affectedTestsFit(root),
    formal: formalPlan(root),
  };
}

/**
 * Keeps the shared CI caller on the job id `ci` with no `name`, so the shared workflow reports `ci / checks`,
 * dispatchable and read-only, with the Renovate sync it would otherwise run turned off. The write permissions the sync
 * needs to push and dispatch the caller live on a separate job calling ci-renovate-sync.yml, which is added when missing.
 * A caller without a `test-job` input gets `test-job: true`, which ci-node.yml v2 accepts and ignores, or `false` when
 * `placeholderTests` says the `test` script only stands in for tests; that case also turns an existing `true` off. Any
 * other explicit value is left as the repository set it. A caller that passes the `NOTION_TOKEN` secret, which ci-node.yml v2
 * ignores, no longer passes it, and `secrets: inherit` stays. The caller passes `single-job: false` when `profile.singleJob` is off, and `affected-tests: true` when
 * `affectedTests` is on. Where sync writes neither, a value the repository set stays.
 * A `checks` job that only re-aggregates the caller (`needs: [ci]`, steps that `exit` on `needs` results) is removed
 * when the workflow has no other job besides the caller and the Renovate sync, since the shared workflow already
 * reports `ci / checks` and each `needs` hop adds to the critical path. A gate that also covers repository-specific
 * jobs is kept. The caller forwards the dispatch `nightly` input, and a `verdict` job needs every other job.
 * The workflow declares exactly the `ciTriggers` of the trunk-based CI: pull requests, the merge queue, pushes to `main`, the nightly run and dispatch;
 * a profile with an `integrationBranch` pushes on that branch instead, and keeps `merge_group`. Unless
 * `profile.windowsOnPullRequests` lets the repository ask for Windows on pull requests, no caller passes
 * `windows-pull-requests` or a `windows` other than the opt-out `false`. Sync writes neither input.
 * Every job calling ci-node.yml or ci-renovate-sync.yml calls it at `CI_NODE_REF` or `CI_RENOVATE_SYNC_REF`, whatever
 * ref it had. A workflow with no caller job is repository-specific CI and is left as it is.
 * When `docsFiles` computes paths, every caller's `docs-files` input lists them first, then keeps its hand-listed paths
 * that still exist, so sync never drops coverage.
 * The jobs with no job-level `uses` follow {@link settleHandWritten}.
 */
export function ciWorkflow(
  current: string | undefined,
  callers: { id: string; named: boolean }[],
  syncCallers: { id: string }[],
  plan: CiPlan = {},
): CiWorkflowResult {
  const { docsFiles, profile = DEFAULT_PROFILE } = plan;
  const placeholderTests = plan.placeholderTests === true;
  if (current === undefined)
    return ciWorkflow(
      newCaller(placeholderTests),
      [{ id: CI_JOB_ID, named: false }],
      [{ id: RENOVATE_SYNC_JOB_ID }],
      plan,
    );
  if (!callers.length) return { content: current, advisories: [] };
  const document = parseDocument(current);
  if (document.errors.length)
    throw new Error(
      `${CI_PATH}: ${document.errors.map(({ message }) => message).join("; ")}`,
    );
  const jobs = document.get("jobs", true);
  if (!isMap(jobs)) return { content: current, advisories: [] };
  restoreEmptyValueComments(document, current);
  const caller = callers.find(({ id }) => id === CI_JOB_ID) ?? callers[0];
  assertNoClash(jobs, caller.id, syncCallers.length > 0);
  assertNothingNeedsVerdict(jobs, CI_PATH);
  const pair = jobs.items.find(
    ({ key }) => isScalar(key) && key.value === caller.id,
  );
  if (!pair || !isMap(pair.value)) return { content: current, advisories: [] };
  let changed = setCallersDocsFiles(document, jobs, callers, docsFiles);
  changed = pinCallerRefs(jobs, callers, syncCallers, profile) || changed;
  changed =
    renameCaller(document, { key: pair.key, value: pair.value }, caller) ||
    changed;
  changed = grant(document, pair.value, { contents: "read" }) || changed;
  changed = skipRenovateSync(document, pair.value) || changed;
  changed =
    setCallerInputs(document, pair.value, placeholderTests, plan) || changed;
  const triggers = setTriggers(document, profile);
  const hand = settleHandWritten(
    document,
    jobs,
    { id: CI_JOB_ID, job: pair.value },
    plan.formal,
    CI_PATH,
  );
  const settled = settleJobs(document, jobs, syncCallers);
  changed = triggers || settled.changed || changed;
  const stale = staleNeeds(document, CI_PATH, settled.removed);
  if (stale.length) throw new Error(stale.join("\n"));
  const { advisories } = hand;
  if (!changed && !hand.changed) return { content: current, advisories };
  blockOverflowingFlow(document);
  return {
    content: document.toString({ lineWidth: 0, flowCollectionPadding: false }),
    advisories,
  };
}
