import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const PRESET = "@antelopejs/tooling-configs/vitest";
const LIMITS = new Set(["testTimeout", "hookTimeout"]);

function keyName(node: ESTree.ObjectProperty): string | null {
  if (!node.computed && node.key.type === "Identifier") return node.key.name;
  if (node.key.type === "Literal") return String(node.key.value);
  return node.key.type === "TemplateLiteral" &&
    node.key.expressions.length === 0
    ? (node.key.quasis[0]?.value.cooked ?? null)
    : null;
}

/** The local names a value import of the preset binds to `testTimeouts` or to the whole module. */
function presetBindings(node: ESTree.ImportDeclaration): string[] {
  if (node.source.value !== PRESET || node.importKind === "type") return [];
  return node.specifiers.flatMap((specifier) => {
    if (specifier.type === "ImportNamespaceSpecifier")
      return [specifier.local.name];
    if (
      specifier.type === "ImportSpecifier" &&
      specifier.importKind !== "type" &&
      specifier.imported.type === "Identifier" &&
      specifier.imported.name === "testTimeouts"
    )
      return [specifier.local.name];
    return [];
  });
}

/** A vitest config runs on the shared CI test timeout: it uses `testTimeouts` from `@antelopejs/tooling-configs/vitest` and sets no `testTimeout` or `hookTimeout` of its own. */
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
        "This vitest config never uses `testTimeouts` from `@antelopejs/tooling-configs/vitest`, so its tests run on vitest's 5000 ms default. Spread it into `test`.",
    },
  },
  createOnce(context) {
    const bindings = new Set<string>();
    let used = false;
    return {
      before() {
        bindings.clear();
        used = false;
      },
      ImportDeclaration(node) {
        for (const name of presetBindings(node)) bindings.add(name);
      },
      Identifier(node) {
        if (
          bindings.has(node.name) &&
          node.parent.type !== "ImportSpecifier" &&
          node.parent.type !== "ImportNamespaceSpecifier"
        )
          used = true;
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
        if (!used) context.report({ node, messageId: "frameworkDefault" });
      },
    };
  },
});
