import { NOW } from "./fake-api.ts";
import type { JsonValue } from "../json.ts";

const HOUR = 60 * 60 * 1000;

export function ago(hours: number): string {
  return new Date(NOW.getTime() - hours * HOUR).toISOString();
}

export function run(
  id: number,
  conclusion: string,
  hoursAgo: number,
  seconds = 60,
): JsonValue {
  return {
    id,
    conclusion,
    created_at: ago(hoursAgo),
    run_started_at: ago(hoursAgo),
    updated_at: new Date(
      NOW.getTime() - hoursAgo * HOUR + seconds * 1000,
    ).toISOString(),
    html_url: `https://github.com/AntelopeJS/x/actions/runs/${id}`,
    head_sha: `sha${id}`,
  };
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

export const CALLER =
  "name: ci\non: push\njobs:\n  ci:\n    uses: AntelopeJS/.github/.github/workflows/ci-node.yml@v1\n";
export const LOCK = (version: string) =>
  `importers:\n  .:\n    devDependencies:\n      '@antelopejs/tooling-configs':\n        specifier: ^${version}\n        version: ${version}(oxlint@1.81.0)\n`;
