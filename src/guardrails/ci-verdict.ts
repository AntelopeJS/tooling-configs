import {
  isMap,
  isScalar,
  parseDocument,
  type Document,
  type YAMLMap,
} from "yaml";

import { RUNS_ON } from "./ci-hand-jobs.ts";
import { neededIds } from "./workflow-needs.ts";

/** The caller job the merge queue waits for: it needs every other job of the file, so none is a result the queue merges past. */
export const VERDICT_JOB_ID = "verdict";

/** The `workflow_dispatch` trigger of a caller, whose `nightly` input runs the nightly tier on a branch. */
export const DISPATCH_TRIGGER = `  workflow_dispatch:
    inputs:
      nightly:
        description: Run the nightly tier, with the Windows jobs and Stress
        type: boolean
        default: false
`;

/** The value of the caller's `nightly` input, which forwards the dispatch input to ci-node.yml and is `false` on any other event. */
export const NIGHTLY_INPUT = "${{ inputs.nightly == true }}";

/** The verdict job of the `.github` README's "The verdict of a caller", as an entry of `jobs:` needing `needs`. */
export function verdictJob(needs: readonly string[]): string {
  return `  ${VERDICT_JOB_ID}:
    needs: [${needs.join(", ")}]
    if: \${{ !cancelled() }}
    runs-on: ${RUNS_ON.linux}
    timeout-minutes: 5
    permissions: {}
    steps:
      - name: Fail when a job failed or was cancelled
        env:
          NEEDS: \${{ toJSON(needs) }}
        run: |
          failed=$(jq -r 'to_entries[] | select(.value.result == "failure" or .value.result == "cancelled") | "\\(.key): \\(.value.result)"' <<< "$NEEDS")
          if [ -n "$failed" ]; then
            echo "$failed"
            exit 1
          fi
`;
}

/**
 * Whether the job runs with `if: !cancelled()`, with or without the expression braces. Unlike `always()`, it ends the
 * job cancelled without a runner in a run that was cancelled, a conclusion that blocks a merge as a failure does, while
 * a failed job of a run that goes on still runs it; a self-hosted runner pool then never runs a verdict only to fail it.
 */
function runsUnlessCancelled(job: YAMLMap): boolean {
  const condition = job.get("if");
  return (
    String(condition) === condition &&
    /^!\s*cancelled\(\)$/.test(
      condition.replace(/^\$\{\{([\s\S]*)\}\}$/, "$1").trim(),
    )
  );
}

/**
 * Gives `jobs` a `verdict` job that needs every other job and runs with `if: ${{ !cancelled() }}`. A missing verdict gets the
 * canonical job; an existing one keeps its steps and has its `needs` and `if` set when they differ.
 */
export function setVerdict(document: Document, jobs: YAMLMap): boolean {
  const others = jobs.items.flatMap(({ key }) =>
    isScalar(key) && key.value !== VERDICT_JOB_ID ? [String(key.value)] : [],
  );
  const verdict = jobs.get(VERDICT_JOB_ID, true);
  if (!isMap(verdict)) {
    jobs.set(
      VERDICT_JOB_ID,
      parseDocument(`jobs:\n${verdictJob(others)}`).getIn(
        ["jobs", VERDICT_JOB_ID],
        true,
      ),
    );
    return true;
  }
  const needed = new Set(neededIds(verdict));
  const needsAll =
    needed.size === others.length && others.every((id) => needed.has(id));
  if (!needsAll)
    verdict.set("needs", document.createNode(others, { flow: true }));
  if (runsUnlessCancelled(verdict)) return !needsAll;
  verdict.set("if", "${{ !cancelled() }}");
  return true;
}

/**
 * Throws when a job of `jobs` in the workflow at `path` needs the verdict, naming each such job: the verdict needs every
 * other job, so having it need that job back writes a cycle GitHub rejects.
 */
export function assertNothingNeedsVerdict(jobs: YAMLMap, path: string): void {
  const dependents = jobs.items.flatMap(({ key, value }) =>
    isScalar(key) &&
    key.value !== VERDICT_JOB_ID &&
    isMap(value) &&
    neededIds(value).includes(VERDICT_JOB_ID)
      ? [String(key.value)]
      : [],
  );
  if (!dependents.length) return;
  throw new Error(
    dependents
      .map(
        (id) =>
          `${path}: job ${id} needs ${VERDICT_JOB_ID}, which needs every other job, so the two would form a cycle GitHub rejects. Remove ${VERDICT_JOB_ID} from the needs: of ${id}, then rerun antelopejs-sync.`,
      )
      .join("\n"),
  );
}

/** The jobs the `verdict` job of the workflow `text` needs, none when it has no verdict or does not parse. */
function verdictNeeds(text: string): string[] {
  const verdict = parseDocument(text).getIn(["jobs", VERDICT_JOB_ID], true);
  return isMap(verdict) ? neededIds(verdict) : [];
}

/**
 * A note naming each job of `current` that the verdict of `content` needs and the verdict of `current` did not, so a drift
 * report says which result the merge queue merged past, or that `current` has no verdict at all. A job sync adds or
 * renames is not one the verdict missed, and a file sync leaves unchanged gets no note.
 */
export function verdictNotes(
  path: string,
  current: string | undefined,
  content: string,
): string[] {
  if (current === undefined || current === content) return [];
  const jobs = parseDocument(current).get("jobs", true);
  if (isMap(jobs) && !jobs.has(VERDICT_JOB_ID))
    return [
      `${path}: has no ${VERDICT_JOB_ID} job, so the merge queue merges past every result. Sync adds one that needs every other job.`,
    ];
  const before = new Set(verdictNeeds(current));
  const missing = verdictNeeds(content).filter(
    (id) => isMap(jobs) && jobs.has(id) && !before.has(id),
  );
  return missing.length
    ? [
        `${path}: ${VERDICT_JOB_ID} does not need ${missing.join(", ")}, so the merge queue merges past ${missing.length === 1 ? "its result" : "their results"}. Sync adds ${missing.length === 1 ? "it" : "them"} to the needs: of ${VERDICT_JOB_ID}.`,
      ]
    : [];
}
