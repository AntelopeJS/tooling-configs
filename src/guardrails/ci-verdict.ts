import {
  isMap,
  isScalar,
  parseDocument,
  type Document,
  type YAMLMap,
} from "yaml";

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
    if: \${{ always() }}
    runs-on: \${{ vars.RUNNER_CI || 'ubuntu-latest' }}
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

function runsAlways(job: YAMLMap): boolean {
  const condition = job.get("if");
  return (
    String(condition) === condition &&
    condition.replace(/^\$\{\{([\s\S]*)\}\}$/, "$1").trim() === "always()"
  );
}

/**
 * Gives `jobs` a `verdict` job that needs every other job and runs with `if: always()`. A missing verdict gets the
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
  if (runsAlways(verdict)) return !needsAll;
  verdict.set("if", "${{ always() }}");
  return true;
}
