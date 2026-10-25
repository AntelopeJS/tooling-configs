import { defineConfig } from "oxlint";

import {
  ANTELOPE_IGNORE_PATTERNS,
  antelopePreset,
  antiSlopRules,
  guardrailsRules,
} from "./src/oxc/lint.ts";

/** Resolve plugins from source so a fresh checkout can lint before building. */
export default defineConfig({
  extends: [
    guardrailsRules(),
    antelopePreset({ antiSlop: false, guardrails: false, typeAware: false }),
  ],
  ignorePatterns: [...ANTELOPE_IGNORE_PATTERNS, "src/oxc/anti-slop/**"],
  jsPlugins: [
    { name: "anti-slop", specifier: "./src/oxc/anti-slop/index.ts" },
    { name: "antelopejs", specifier: "./src/oxc/guardrails/index.ts" },
  ],
  rules: antiSlopRules(),
});
