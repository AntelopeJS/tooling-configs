import { defineConfig } from "oxlint";

import {
  ANTELOPE_IGNORE_PATTERNS,
  antelopePreset,
  antiSlopRules,
} from "./src/oxc/lint.ts";

export default defineConfig({
  // The plugin is registered from source, not through this package's own
  // exports: resolving those would mean building before every lint, which
  // breaks a fresh clone, `pnpm release`, and CI alike.
  extends: [antelopePreset({ antiSlop: false, typeAware: false })],
  ignorePatterns: [...ANTELOPE_IGNORE_PATTERNS, "src/oxc/anti-slop/**"],
  jsPlugins: [{ name: "anti-slop", specifier: "./src/oxc/anti-slop/index.ts" }],
  rules: antiSlopRules("warn"),
});
