import { defineConfig } from "oxlint";

import { antelopePreset } from "./src/oxc/lint.ts";

export default defineConfig({
  // The vendored plugin is upstream's source, kept byte-identical for diffing.
  ignorePatterns: ["src/oxc/anti-slop/**"],
  extends: [antelopePreset({ typeAware: false })],
});
