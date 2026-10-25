import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode, Scope } from "@oxlint/plugins";
import { memberName } from "../shared.ts";

const fsModules = new Set(["fs", "node:fs"]);
const readMethods = new Set(["readFileSync", "readdirSync"]);

function isFsRequire(node: ESTree.Expression): boolean {
  return (
    node.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "require" &&
    node.arguments[0]?.type === "Literal" &&
    fsModules.has(String(node.arguments[0].value))
  );
}

function isFsNamespace(source: SourceCode, node: ESTree.Expression): boolean {
  if (isFsRequire(node)) return true;
  if (node.type !== "Identifier") return false;
  let scope: Scope | null = source.getScope(node);
  while (scope !== null) {
    const binding = scope.set.get(node.name);
    if (binding !== undefined) {
      return binding.defs.some((definition) => {
        if (definition.node.type === "TSImportEqualsDeclaration") {
          const reference = definition.node.moduleReference;
          return (
            reference.type === "TSExternalModuleReference" &&
            fsModules.has(reference.expression.value)
          );
        }
        if (definition.type === "ImportBinding") {
          return (
            (definition.node.type !== "ImportSpecifier" ||
              (definition.node.imported.type === "Identifier" &&
                definition.node.imported.name === "default")) &&
            definition.parent?.type === "ImportDeclaration" &&
            fsModules.has(definition.parent.source.value)
          );
        }
        return (
          definition.node.type === "VariableDeclarator" &&
          definition.node.init !== null &&
          isFsRequire(definition.node.init)
        );
      });
    }
    scope = scope.upper;
  }
  return false;
}

/** Tests exercise behavior through public interfaces rather than reading implementation text. */
export const noFsReadInTestsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Move synchronous filesystem reads out of tests into fixture helpers.",
    },
    messages: {
      fsRead:
        "Tests exercise behaviour through the public interface. A test that reads source files asserts text, not behaviour. Move fixture reads into a helper under fixtures/, helpers/ or locales/.",
    },
  },
  createOnce(context) {
    return {
      ImportDeclaration(node) {
        if (!fsModules.has(node.source.value) || node.importKind === "type")
          return;
        for (const specifier of node.specifiers) {
          if (
            specifier.type !== "ImportSpecifier" ||
            specifier.importKind === "type"
          )
            continue;
          const name =
            specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : specifier.imported.value;
          if (readMethods.has(name))
            context.report({ node: specifier, messageId: "fsRead" });
        }
      },
      MemberExpression(node) {
        const name = memberName(node);
        if (
          name !== null &&
          readMethods.has(name) &&
          isFsNamespace(context.sourceCode, node.object)
        ) {
          context.report({ node, messageId: "fsRead" });
        }
      },
      VariableDeclarator(node) {
        if (
          node.id.type !== "ObjectPattern" ||
          node.init === null ||
          !isFsNamespace(context.sourceCode, node.init)
        )
          return;
        for (const property of node.id.properties) {
          if (property.type !== "Property") continue;
          const name =
            property.key.type === "Identifier" && !property.computed
              ? property.key.name
              : property.key.type === "Literal"
                ? String(property.key.value)
                : null;
          if (name !== null && readMethods.has(name))
            context.report({ node: property, messageId: "fsRead" });
        }
      },
    };
  },
});
