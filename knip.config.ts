import { antelopeKnipConfig } from "./src/knip.ts";

export default {
  ...antelopeKnipConfig({
    ignore: ["src/oxc/anti-slop/**"],
    ignoreBinaries: ["script"],
  }),
  workspaces: {
    "actions/docs": {
      entry: ["check.mjs", "check.test.mjs"],
      project: ["*.mjs"],
    },
  },
};
