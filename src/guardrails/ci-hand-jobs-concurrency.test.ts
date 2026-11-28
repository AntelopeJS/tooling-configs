import assert from "node:assert/strict";
import test from "node:test";
import { isMap, parseDocument } from "yaml";

import {
  CANCEL_IN_PROGRESS,
  rewriteHandJobs,
  RUNS_ON,
} from "./ci-hand-jobs.ts";
import { CI_PATH } from "./ci-workflow.ts";
import { syncCi, workflowWith } from "./helpers/ci-text.ts";

const LINT = `  lint:
    runs-on: ${RUNS_ON.linux}
    steps:
      - run: pnpm lint
`;

const BLOCK = `permissions:
  contents: read

concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}

jobs:
`;

interface ConcurrencyView {
  group?: string;
  "cancel-in-progress"?: string | boolean;
}

function concurrencyOf(text: string): ConcurrencyView | undefined {
  return parseDocument(text).toJS().concurrency;
}

test("a workflow with a hand-written job gets the concurrency block between permissions and jobs, with a blank line on both sides, so a sync that appends it elsewhere or glues it to jobs fails", () => {
  const { content } = syncCi(workflowWith(LINT));
  assert.ok(content.includes(BLOCK), content);
});

test("the block is written once and a second run changes nothing, so a sync that inserts a second block fails", () => {
  const once = syncCi(workflowWith(LINT)).content;
  assert.equal(once.match(/^concurrency:/gm)?.length, 1);
  assert.equal(syncCi(once).content, once);
});

test("only callers and aggregators leave the workflow without concurrency, so a sync that adds it for any workflow fails", () => {
  assert.equal(concurrencyOf(syncCi(workflowWith("")).content), undefined);
  const aggregator = `  gate:\n    needs: [ci]\n    runs-on: ${RUNS_ON.linux}\n    steps:\n      - run: exit 0\n`;
  assert.equal(
    concurrencyOf(syncCi(workflowWith(aggregator)).content),
    undefined,
  );
});

test("a workflow that is not triggered by pull requests gets none, so a sync that ignores the trigger fails", () => {
  const document = parseDocument(
    `on: push\njobs:\n  ci:\n    uses: x/y/.github/workflows/z.yml@v1\n${LINT}`,
  );
  const jobs = document.get("jobs", true);
  assert.ok(isMap(jobs));
  rewriteHandJobs(document, jobs, CI_PATH);
  assert.equal(document.get("concurrency"), undefined);
});

test("a wrong cancel-in-progress is the only key set, so a sync that replaces the group or the whole block fails", () => {
  const before = workflowWith(LINT).replace(
    "jobs:\n",
    "concurrency:\n  group: custom-${{ github.ref }}\n  cancel-in-progress: true\n\njobs:\n",
  );
  const { content } = syncCi(before);
  assert.deepEqual(concurrencyOf(content), {
    group: "custom-${{ github.ref }}",
    "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
  });
  assert.equal(syncCi(content).content, content);
});

test("a right cancel-in-progress leaves the block as written, keys in their order, so a sync that rebuilds it from the template fails", () => {
  const own = `concurrency:\n  cancel-in-progress: ${CANCEL_IN_PROGRESS}\n  group: mine\n\njobs:\n`;
  const { content } = syncCi(workflowWith(LINT).replace("jobs:\n", own));
  assert.ok(content.includes(own), content);
});

test("a concurrency written as a bare group becomes a map that keeps the group, so a sync that drops the group fails", () => {
  const before = workflowWith(LINT).replace(
    "jobs:\n",
    "concurrency: ci-${{ github.ref }}\n\njobs:\n",
  );
  assert.deepEqual(concurrencyOf(syncCi(before).content), {
    group: "ci-${{ github.ref }}",
    "cancel-in-progress": CANCEL_IN_PROGRESS,
  });
});
