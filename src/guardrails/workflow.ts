import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";

import type { PlannedArtifact } from "./sync.ts";

/** The major of the AntelopeJS/.github tag every workflow sync writes calls; a repository that has not synced keeps its own ref. */
const SHARED_WORKFLOWS_MAJOR = 2;
export const SHARED_WORKFLOWS_TAG = `v${SHARED_WORKFLOWS_MAJOR}`;

/** The `uses:` ref of the shared workflow `file` at the tag sync writes. */
export function sharedWorkflow(file: string): string {
  return `AntelopeJS/.github/.github/workflows/${file}@${SHARED_WORKFLOWS_TAG}`;
}

/** A `uses:` line calling a shared workflow the tag ships; one it does not ship, such as the retired modules-update.yml, keeps its ref. */
const SHARED_USES =
  /^(\s*(?:-\s+)?uses:\s*["']?)(AntelopeJS\/\.github\/\.github\/workflows\/(?:ci-node|ci-renovate-sync|release-npm-public|release-npm-private)\.yml@)([^\s"'#]+)/gm;

const MAJOR_TAG = /^v(\d+)$/;

/**
 * Each `uses:` value in a workflow file that calls a shared workflow the tag ships at an older major tag, such as `ci-node.yml@v1`
 * while sync writes `@v2`: the call only antelopejs-sync from a release at the tag moves.
 */
export function olderMajorCalls(text: string): string[] {
  return [...text.matchAll(SHARED_USES)].flatMap(([, , call, ref]) => {
    const major = MAJOR_TAG.exec(ref)?.[1];
    return major !== undefined && Number(major) < SHARED_WORKFLOWS_MAJOR
      ? [`${call}${ref}`]
      : [];
  });
}

/** `text` with every call to a shared workflow the tag ships moved to the tag, its lines otherwise byte for byte. */
function pinSharedWorkflows(text: string): string {
  return text.replace(
    SHARED_USES,
    (_line, lead: string, call: string) =>
      `${lead}${call}${SHARED_WORKFLOWS_TAG}`,
  );
}

const CI_NODE_PATTERN =
  /^AntelopeJS\/\.github\/\.github\/workflows\/ci-node\.yml@\S+$/;
const CI_RENOVATE_SYNC_PATTERN =
  /^AntelopeJS\/\.github\/\.github\/workflows\/ci-renovate-sync\.yml@\S+$/;

/** The shared workflows the trunk-based flow retires: a caller file whose jobs all call them is deleted, a file with any other job only stops being pinned. */
const RETIRED_SHARED_WORKFLOWS = ["next-sync.yml", "stale.yml"] as const;

const RETIRED_CALL = new RegExp(
  `^AntelopeJS/\\.github/\\.github/workflows/(?:${RETIRED_SHARED_WORKFLOWS.map((file) => file.replace(".", "\\.")).join("|")})@\\S+$`,
);

function callsOnlyRetiredWorkflows(text: string): boolean {
  const document = parseDocument(text);
  const jobs = document.errors.length ? undefined : document.get("jobs", true);
  if (!isMap(jobs) || !jobs.items.length) return false;
  return jobs.items.every(({ value: job }) => {
    const uses = isMap(job) ? job.get("uses", true) : undefined;
    return isScalar(uses) && RETIRED_CALL.test(String(uses.value));
  });
}

/** A `remove` for every workflow file whose jobs all call a retired shared workflow, at any ref. */
export function retiredWorkflowArtifacts(root: string): PlannedArtifact[] {
  const directory = join(root, ".github/workflows");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => `.github/workflows/${name}`)
    .filter((path) =>
      callsOnlyRetiredWorkflows(readFileSync(join(root, path), "utf8")),
    )
    .map((path): PlannedArtifact => ({ kind: "remove", path }));
}

/** Moves the shared-workflow calls of each workflow file no other artifact of `planned` writes or removes to the tag. */
export function sharedRefArtifacts(
  root: string,
  planned: ReadonlySet<string>,
): PlannedArtifact[] {
  const directory = join(root, ".github/workflows");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => `.github/workflows/${name}`)
    .filter((path) => !planned.has(path))
    .map((path): PlannedArtifact => {
      const current = readFileSync(join(root, path), "utf8");
      const content = pinSharedWorkflows(current);
      return content === current
        ? { kind: "unchanged", path }
        : { kind: "write", path, content, mode: undefined };
    });
}

export const MISSING_CHECKS_WORKFLOW =
  "No workflow in .github/workflows runs pnpm run checks. Add a step running `pnpm run checks` (or `pnpm checks`), or a job using AntelopeJS/.github/.github/workflows/ci-node.yml@<ref>.";

export function hasChecksWorkflow(root: string): boolean {
  const directory = join(root, ".github/workflows");
  if (!existsSync(directory)) return false;
  for (const file of readdirSync(directory).filter((name) =>
    /\.ya?ml$/.test(name),
  )) {
    const document = parseDocument(readFileSync(join(directory, file), "utf8"));
    if (document.errors.length) continue;
    const jobs = document.get("jobs", true);
    if (!isMap(jobs)) continue;
    for (const { value: job } of jobs.items) {
      if (!isMap(job)) continue;
      const uses = job.get("uses", true);
      if (isScalar(uses) && CI_NODE_PATTERN.test(String(uses.value)))
        return true;
      const steps = job.get("steps", true);
      if (!isSeq(steps)) continue;
      for (const step of steps.items) {
        if (!isMap(step)) continue;
        const run = step.get("run", true);
        if (
          isScalar(run) &&
          /(?:^|\n|&&|;)\s*pnpm\s+(?:run\s+)?checks(?=\s*(?:$|\n|&&|;|#))/.test(
            String(run.value),
          )
        )
          return true;
      }
    }
  }
  return false;
}

export interface CiCaller {
  id: string;
  uses: string;
  named: boolean;
}

function callers(text: string, pattern: RegExp): CiCaller[] {
  const document = parseDocument(text);
  const jobs = document.errors.length ? undefined : document.get("jobs", true);
  if (!isMap(jobs)) return [];
  const found: CiCaller[] = [];
  for (const { key, value: job } of jobs.items) {
    if (!isMap(job)) continue;
    const uses = job.get("uses", true);
    if (isScalar(uses) && pattern.test(String(uses.value)))
      found.push({
        id: String(isScalar(key) ? key.value : key),
        uses: String(uses.value),
        named: job.has("name"),
      });
  }
  return found;
}

/** Jobs of a workflow file that call the shared Node CI; empty when the YAML does not parse. */
export function ciNodeCallers(text: string): CiCaller[] {
  return callers(text, CI_NODE_PATTERN);
}

/** Jobs of a workflow file that call the shared Renovate sync at any ref; empty when the YAML does not parse. */
export function ciRenovateSyncCallers(text: string): CiCaller[] {
  return callers(text, CI_RENOVATE_SYNC_PATTERN);
}
