import { antelopeKnipConfig } from "./src/knip.ts";

export default {
  ...antelopeKnipConfig({
    entry: [
      "src/oxc/guardrails/rules/fixtures/eslint/require-assertion.config.mjs",
    ],
    ignore: ["src/oxc/anti-slop/**"],
    ignoreBinaries: ["icacls", "netstat", "script"],
  }),
  workspaces: {
    "actions/docs": {
      entry: ["check.mjs", "check.test.mjs"],
      project: ["*.mjs"],
    },
  },
};
