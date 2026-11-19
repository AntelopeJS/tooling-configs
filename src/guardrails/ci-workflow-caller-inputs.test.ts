import assert from "node:assert/strict";
import { statSync } from "node:fs";
import test from "node:test";
import { parseDocument } from "yaml";

import { MAX_FILE_BYTES } from "./ceilings.ts";
import {
  CI_CALLER,
  CI_NODE_REF,
  ciProfile,
  ciWorkflow,
  type CiProfile,
} from "./ci-workflow.ts";
import { ciNodeCallers, ciRenovateSyncCallers } from "./workflow.ts";

const NOTION_TOKEN = "${{ secrets.NOTION_TOKEN }}";

const SLOW_TEST_PACKAGES = [
  "dms-workspace",
  "@antelopejs/core",
  "@antelopejs/dms-frontend",
  "@antelopejs/mongodb",
  "@antelopejs/dms-assistant",
];

function rewrite(text: string, profile?: CiProfile): string {
  return ciWorkflow(text, ciNodeCallers(text), ciRenovateSyncCallers(text), {
    profile,
  });
}

interface CallerView {
  with?: Record<string, string | boolean>;
  secrets?: string | Record<string, string>;
}

function caller(text: string): CallerView {
  return parseDocument(text).toJS().jobs.ci;
}

test("every caller passes NOTION_TOKEN to ci-node.yml and keeps its other secrets, so a sync that leaves the merge queue unable to file a flaky-test task or drops a secret the repository passes fails", () => {
  assert.deepEqual(caller(CI_CALLER).secrets, { NOTION_TOKEN });
  const bare = `jobs:\n  ci:\n    uses: ${CI_NODE_REF}\n`;
  assert.deepEqual(caller(rewrite(bare)).secrets, { NOTION_TOKEN });
  const own = `jobs:\n  ci:\n    uses: ${CI_NODE_REF}\n    secrets:\n      NPM_TOKEN: \${{ secrets.NPM_TOKEN }}\n      NOTION_TOKEN: \${{ secrets.OTHER }}\n`;
  assert.deepEqual(caller(rewrite(own)).secrets, {
    NPM_TOKEN: "${{ secrets.NPM_TOKEN }}",
    NOTION_TOKEN,
  });
  const once = rewrite(bare);
  assert.equal(rewrite(once), once);
});

test("a caller with secrets: inherit keeps it, since it already passes NOTION_TOKEN, so a sync that replaces it with one secret fails", () => {
  const inherit = `jobs:\n  ci:\n    uses: ${CI_NODE_REF}\n    secrets: inherit\n`;
  assert.equal(caller(rewrite(inherit)).secrets, "inherit");
});

test("the repositories whose tests take minutes get single-job: false on a new or existing caller, so a sync that leaves them in one job or forgets one of them fails", () => {
  for (const name of SLOW_TEST_PACKAGES) {
    const profile = ciProfile(name);
    const written = ciWorkflow(undefined, [], [], { profile });
    assert.equal(caller(written).with?.["single-job"], false, name);
    const rewritten = rewrite(CI_CALLER, profile);
    assert.equal(caller(rewritten).with?.["single-job"], false, name);
    assert.equal(rewrite(rewritten, profile), rewritten, name);
    const bare = `jobs:\n  ci:\n    uses: ${CI_NODE_REF}\n`;
    assert.equal(caller(rewrite(bare, profile)).with?.["single-job"], false);
  }
});

test("any other repository gets no single-job input and keeps one it set, so a sync that writes single-job everywhere or erases a hand-set value fails", () => {
  const profile = ciProfile("@antelopejs/interface-core");
  assert.equal(profile.singleJob, true);
  assert.equal(rewrite(CI_CALLER, profile), CI_CALLER);
  const own = CI_CALLER.replace(
    "test-job: true",
    "test-job: true\n      single-job: false",
  );
  assert.equal(rewrite(own, profile), own);
});

test("ci-workflow.ts keeps 1000 bytes of headroom under the file-size ceiling, so a change that refills it instead of extending a sibling module fails", () => {
  const { size } = statSync(new URL("./ci-workflow.ts", import.meta.url));
  assert.ok(size <= MAX_FILE_BYTES - 1000, `${size} bytes`);
});
