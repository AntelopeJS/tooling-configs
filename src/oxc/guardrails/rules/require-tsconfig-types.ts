import { relative } from "node:path";

import { defineRule } from "@oxlint/plugins";

import { automaticTypes, programConfig } from "../tsconfig-program.ts";

const TYPE_LINTED = /\.[cm]?[jt]sx?$/u;

/** The tsconfig of a file type-aware lint reads must list `compilerOptions.types`, or tsgolint loads none of the `@types` packages tsc loads. */
export const requireTsconfigTypesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "The tsconfig.json of every file type-aware lint reads lists compilerOptions.types, so tsgolint loads the same @types packages as tsc.",
    },
    messages: {
      missing:
        '{{config}} lists no `compilerOptions.types`, so tsc loads every `@types` package ({{packages}}) but type-aware lint, which runs TypeScript 7, loads none: Node and test-runner globals are error types, so `typescript/no-unsafe-*` reports here are false and findings that need those types go missing. Add `"types": [{{list}}]` to its compilerOptions, or the subset this code uses.',
    },
  },
  createOnce(context) {
    return {
      Program(node) {
        if (!TYPE_LINTED.test(context.filename)) return;
        const config = programConfig(context.filename);
        if (config === undefined) return;
        const packages = automaticTypes(config);
        if (packages.length === 0) return;
        context.report({
          node,
          messageId: "missing",
          data: {
            config: relative(context.cwd, config).replaceAll("\\", "/"),
            packages: packages.join(", "),
            list: packages.map((name) => JSON.stringify(name)).join(", "),
          },
        });
      },
    };
  },
});
