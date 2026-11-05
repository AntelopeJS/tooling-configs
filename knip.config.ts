import { antelopeKnipConfig } from "./src/knip.ts";

export default {
  ...antelopeKnipConfig({ ignore: ["src/oxc/anti-slop/**"] }),
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
