import { defineConfig } from "tsdown";

/** The lint tools and plugins are resolved from the consumer's node_modules at lint time, never bundled. */
export default defineConfig({
  entry: [
    "./src/oxc/lint.ts",
    "./src/oxc/fmt.ts",
    "./src/oxc/anti-slop/index.ts",
    "./src/oxc/guardrails/index.ts",
    "./src/knip.ts",
    "./src/eslint.ts",
    "./src/verify/index.ts",
    "./src/formal/index.ts",
    "./src/bin/check-interface-ranges.ts",
    "./src/bin/sync.ts",
    "./src/bin/check-size.ts",
    "./src/bin/ratchet.ts",
    "./src/bin/suppressions.ts",
    "./src/bin/checks.ts",
    "./src/bin/api-diff.ts",
    "./src/bin/body-check.ts",
    "./src/bin/comment-proof.ts",
    "./src/bin/garden.ts",
    "./src/bin/verify.ts",
  ],
  outDir: "dist",
  format: ["esm"],
  dts: true,
  clean: true,
  target: false,
  deps: {
    neverBundle: [
      "oxlint",
      "oxfmt",
      "@oxlint/plugins",
      "eslint-plugin-perfectionist",
    ],
  },
});
