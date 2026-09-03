import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "./src/oxc/lint.ts",
    "./src/oxc/fmt.ts",
    "./src/oxc/anti-slop/index.ts",
    "./src/knip.ts",
    "./src/eslint.ts",
  ],
  outDir: "dist",
  format: ["esm"],
  dts: true,
  clean: true,
  target: false,
  deps: {
    // Resolved from the consumer's node_modules at lint time, never bundled.
    neverBundle: [
      "oxlint",
      "oxfmt",
      "@oxlint/plugins",
      "eslint-plugin-perfectionist",
    ],
  },
});
