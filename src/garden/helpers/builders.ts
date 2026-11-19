import { NOW } from "./fake-api.ts";
import type { JsonObject, JsonValue } from "../json.ts";

const HOUR = 60 * 60 * 1000;

export function ago(hours: number): string {
  return new Date(NOW.getTime() - hours * HOUR).toISOString();
}

export function run(
  id: number,
  conclusion: string,
  hoursAgo: number,
  seconds = 60,
  workflowSha?: string,
): JsonObject {
  const body: JsonObject = {
    id,
    event: "push",
    conclusion,
    created_at: ago(hoursAgo),
    run_started_at: ago(hoursAgo),
    updated_at: new Date(
      NOW.getTime() - hoursAgo * HOUR + seconds * 1000,
    ).toISOString(),
    html_url: `https://github.com/AntelopeJS/x/actions/runs/${id}`,
    head_sha: `sha${id}`,
  };
  if (workflowSha !== undefined)
    body.referenced_workflows = [
      {
        path: "AntelopeJS/.github/.github/workflows/ci-node.yml@refs/tags/v1",
        ref: "refs/tags/v1",
        sha: workflowSha,
      },
    ];
  return body;
}

/** A completed `merge_group` run of ci.yml whose check suite is `checkSuiteId`. */
export function queueRun(
  id: number,
  checkSuiteId: number,
  hoursAgo: number,
): JsonObject {
  return {
    ...run(id, "success", hoursAgo),
    event: "merge_group",
    check_suite_id: checkSuiteId,
  };
}

/** A check run annotation as GitHub lists it. */
export function annotation(
  level: string,
  title: string,
  message: string,
): JsonObject {
  return { annotation_level: level, title, message };
}

/** The warning ci-node.yml v2 writes for a test that passed only on its merge-queue retry. */
export function flakyAnnotation(repo: string, test: string): JsonObject {
  return annotation(
    "warning",
    "Flaky test",
    `AntelopeJS/${repo}: ${test} passed only on its merge-queue retry.`,
  );
}

export function checkRun(name: string, conclusion: string): JsonValue {
  return {
    id: 1,
    name,
    conclusion,
    html_url: `https://github.com/AntelopeJS/x/runs/${name}`,
    output: { summary: "" },
  };
}

export function pull(
  number: number,
  title: string,
  login: string,
  hoursAgo: number,
): JsonValue {
  return {
    number,
    title,
    html_url: `https://github.com/AntelopeJS/x/pull/${number}`,
    created_at: ago(hoursAgo),
    user: { login },
  };
}

export const CALLER = [
  "name: ci",
  "on: push",
  "jobs:",
  "  ci:",
  "    permissions:",
  "      contents: read",
  "    uses: AntelopeJS/.github/.github/workflows/ci-node.yml@v2",
  "    with:",
  "      renovate-sync: false",
  "  renovate-sync:",
  "    permissions:",
  "      contents: write",
  "      actions: write",
  "    uses: AntelopeJS/.github/.github/workflows/ci-renovate-sync.yml@v2",
  "",
].join("\n");
export const LOCK = (version: string) =>
  `importers:\n  .:\n    devDependencies:\n      '@antelopejs/tooling-configs':\n        specifier: ^${version}\n        version: ${version}(oxlint@1.81.0)\n`;
