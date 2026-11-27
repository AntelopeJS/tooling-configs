import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const PRESET = "@antelopejs/tooling-configs/vitest";
const LIMITS = new Set(["testTimeout", "hookTimeout"]);

function keyName(node: ESTree.ObjectProperty): string | null {
  if (!node.computed && node.key.type === "Identifier") return node.key.name;
  return node.key.type === "Literal" ? String(node.key.value) : null;
}

/** A vitest config runs on the shared CI test timeout: it imports `testTimeouts` from `@antelopejs/tooling-configs/vitest` and sets no `testTimeout` or `hookTimeout` of its own. */
export const sharedTestTimeoutRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Vitest configs take their test and hook timeouts from `@antelopejs/tooling-configs/vitest`.",
    },
    messages: {
      handSet:
        "This vitest config sets its own `{{ key }}`. Spread `testTimeouts` from `@antelopejs/tooling-configs/vitest` into `test` instead, so the tests run on the shared CI test timeout.",
      frameworkDefault:
        "This vitest config never imports `@antelopejs/tooling-configs/vitest`, so its tests run on vitest's 5000 ms default. Spread its `testTimeouts` into `test`.",
    },
  },
  createOnce(context) {
    let imported = false;
    return {
      before() {
        imported = false;
      },
      ImportDeclaration(node) {
        if (node.source.value === PRESET) imported = true;
      },
      ObjectExpression(node) {
        for (const property of node.properties) {
          if (property.type !== "Property") continue;
          const key = keyName(property);
          if (key !== null && LIMITS.has(key))
            context.report({
              node: property,
              messageId: "handSet",
              data: { key },
            });
        }
      },
      "Program:exit"(node) {
        if (!imported) context.report({ node, messageId: "frameworkDefault" });
      },
    };
  },
});
