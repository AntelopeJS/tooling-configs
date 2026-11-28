import assert from "node:assert/strict";
import test from "node:test";

import { ACTION_PINS, RUNS_ON } from "./ci-hand-jobs.ts";
import { syncCi, workflowWith } from "./helpers/ci-text.ts";

const CHECKOUT_PIN =
  "uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";

function stepsWith(...uses: string[]): string {
  const steps = uses.map((use) => `      - uses: ${use}\n`).join("");
  return `  lint:\n    runs-on: ${RUNS_ON.linux}\n    steps:\n${steps}      - run: pnpm lint\n`;
}

test("every pin of the table is a 40-hex commit with a release, so a table entry with a tag or a missing version fails", () => {
  assert.deepEqual([...ACTION_PINS.keys()].sort(), [
    "actions/cache",
    "actions/cache/restore",
    "actions/cache/save",
    "actions/checkout",
    "actions/create-github-app-token",
    "actions/download-artifact",
    "actions/setup-java",
    "actions/setup-node",
    "actions/upload-artifact",
    "pnpm/action-setup",
  ]);
  for (const [name, { sha, version }] of ACTION_PINS) {
    assert.match(sha, /^[0-9a-f]{40}$/, name);
    assert.match(version, /^v\d+\.\d+\.\d+$/, name);
  }
});

test("a step of a hand-written job is pinned to the table's commit with the release as its comment, and the old comment goes, so a pin that keeps `# v4` fails", () => {
  const before = workflowWith(
    stepsWith(
      "actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4",
      "actions/cache/restore@v4",
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4",
    ),
  );
  const { content } = syncCi(before);
  assert.ok(content.includes(`      - ${CHECKOUT_PIN}\n`), content);
  assert.ok(
    content.includes(
      "      - uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0\n",
    ),
    content,
  );
  assert.ok(
    content.includes(
      "      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2\n",
    ),
    content,
  );
  assert.doesNotMatch(content, /# v4/);
});

test("a second run leaves a pinned file untouched, so a pin that rewrites the comment every run fails", () => {
  const once = syncCi(
    workflowWith(stepsWith("actions/checkout@v4", "actions/setup-node@v4")),
  ).content;
  assert.equal(syncCi(once).content, once);
});

test("a local action, a docker image, a shared AntelopeJS action and an unknown action keep their refs, so a pin that rewrites every uses fails", () => {
  const uses = [
    "./.github/actions/setup",
    "docker://alpine:3.20",
    "AntelopeJS/.github/.github/actions/ci-tier@v2",
    "some-org/some-action@v1",
  ];
  const { content } = syncCi(workflowWith(stepsWith(...uses)));
  for (const use of uses)
    assert.ok(content.includes(`      - uses: ${use}\n`), use);
});

test("a job that calls a workflow keeps its uses, so a pin that rewrites job-level uses fails", () => {
  const { content } = syncCi(workflowWith(""));
  assert.match(
    content,
    /uses: AntelopeJS\/\.github\/\.github\/workflows\/ci-node\.yml@v2\n/,
  );
  assert.doesNotMatch(content, /# v\d/);
});
