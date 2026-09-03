import { defineConfig } from "oxlint";

import { ANTELOPE_IGNORE_PATTERNS, antelopePreset } from "./src/oxc/lint.ts";

export default defineConfig({
  // The vendored plugin is upstream's source, kept byte-identical for diffing.
  ignorePatterns: [...ANTELOPE_IGNORE_PATTERNS, "src/oxc/anti-slop/**"],
  extends: [antelopePreset({ typeAware: false })],
});
