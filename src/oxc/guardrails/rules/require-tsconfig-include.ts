import { defineRule } from "@oxlint/plugins";

import { programConfig } from "../tsconfig-program.ts";

const TYPE_LINTED = /\.[cm]?[jt]sx?$/u;

/** A file type-aware lint reads must be listed by a tsconfig, or tsgolint types it without the repository's compiler options and `types`. */
export const requireTsconfigIncludeRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Every file type-aware lint reads is listed by a tsconfig.json, so its findings use the repository's compiler options and types.",
    },
    messages: {
      outside:
        "No tsconfig.json lists this file, so type-aware lint reads it in tsgolint's inferred program, without this repository's compiler options or `types`: Node and test-runner globals are error types, so `typescript/no-unsafe-*` reports here are false and findings that need those types go missing. List the file in a tsconfig.json that names the `types` it uses: one beside it that extends the root tsconfig, or, for a file at the root, a composite tsconfig that the root tsconfig references.",
    },
  },
  createOnce(context) {
    return {
      Program(node) {
        if (
          TYPE_LINTED.test(context.filename) &&
          programConfig(context.filename) === undefined
        )
          context.report({ node, messageId: "outside" });
      },
    };
  },
});
