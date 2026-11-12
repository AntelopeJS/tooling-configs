import { antelopeKnipConfig } from "./src/knip.ts";

export default {
  ...antelopeKnipConfig({
    entry: [
      "src/oxc/guardrails/rules/fixtures/eslint/require-assertion.config.mjs",
    ],
    ignore: ["src/oxc/anti-slop/**"],
    ignoreBinaries: ["icacls", "mkfifo", "script"],
  }),
  workspaces: {
    "actions/docs": {
      entry: ["check.mjs", "check.test.mjs"],
      project: ["*.mjs"],
    },
    "scripts/browser-bench": {
      entry: ["run.mjs", "drivers/*.mjs"],
      project: ["**/*.mjs"],
      ignoreBinaries: ["taskset"],
    },
  },
};
