import typescriptParser from "@typescript-eslint/parser";

import guardrailsPlugin from "../../../index.ts";

export default [
  {
    files: ["**/*.ts"],
    languageOptions: { parser: typescriptParser },
    plugins: { antelopejs: guardrailsPlugin },
    rules: { "antelopejs/require-assertion": "error" },
  },
];
