import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";

import { ciWorkflow, type CiPlan } from "../ci-workflow.ts";
import { ciNodeCallers, ciRenovateSyncCallers } from "../workflow.ts";

/** A job of a parsed workflow, as far as the tests read it. */
export interface JobView {
  needs?: string | string[];
  if?: string;
  uses?: string;
  "runs-on"?: string;
  with?: Record<string, string | boolean>;
  strategy?: { matrix?: { os?: string[] } };
  steps?: { uses?: string; run?: string; if?: string }[];
}

/** The text of a file under `src/guardrails/fixtures`. */
export function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
}

/** What `ciWorkflow` writes for the workflow `text` under `plan`, with the advisories it reports. */
export function syncCi(text: string, plan: CiPlan = {}) {
  return ciWorkflow(
    text,
    ciNodeCallers(text),
    ciRenovateSyncCallers(text),
    plan,
  );
}

/** The parsed `jobs` of the workflow `text`. */
export function jobsOf(text: string): Record<string, JobView> {
  return parseDocument(text).toJS().jobs;
}

/** The `with` inputs of the `ci` caller in `text`. */
export function callerInputs(text: string): Record<string, string | boolean> {
  return jobsOf(text).ci.with ?? {};
}

/** A workflow on pull requests whose jobs are `jobs`, indented under `jobs:` and written by hand, with the shared caller first. */
export function workflowWith(jobs: string): string {
  return `name: ci
on:
  pull_request:
permissions:
  contents: read
jobs:
  ci:
    uses: AntelopeJS/.github/.github/workflows/ci-node.yml@v2
${jobs}`;
}
