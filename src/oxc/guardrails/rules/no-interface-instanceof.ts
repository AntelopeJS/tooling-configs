import { defineRule } from "@oxlint/plugins";

import type { Definition, ESTree } from "@oxlint/plugins";
import { enclosingPackage } from "../self-package.ts";
import { resolveVariable, unwrapExpression } from "../local-types.ts";

const INTERFACE_PACKAGE = /^@antelopejs\/interface-[^/]+/;

function importedFromInterface(definition: Definition): boolean {
  const { node, parent } = definition;
  return (
    definition.type === "ImportBinding" &&
    parent?.type === "ImportDeclaration" &&
    parent.importKind !== "type" &&
    !(node.type === "ImportSpecifier" && node.importKind === "type") &&
    INTERFACE_PACKAGE.test(parent.source.value)
  );
}

function exportedNames(statement: ESTree.Node): string[] {
  if (statement.type === "ExportDefaultDeclaration") {
    const { declaration } = statement;
    if (declaration.type === "Identifier") return [declaration.name];
    return declaration.type === "ClassDeclaration" && declaration.id !== null
      ? [declaration.id.name]
      : [];
  }
  if (statement.type !== "ExportNamedDeclaration") return [];
  const { declaration } = statement;
  if (declaration?.type === "ClassDeclaration" && declaration.id !== null)
    return [declaration.id.name];
  if (statement.source !== null || statement.exportKind === "type") return [];
  return statement.specifiers.flatMap((specifier) =>
    specifier.local.type === "Identifier" && specifier.exportKind !== "type"
      ? [specifier.local.name]
      : [],
  );
}

/** `instanceof C` is false for a value built by another copy of the package that declares `C`, so an interface package's classes need a brand guard. */
export const noInterfaceInstanceofRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Reject instanceof against a class of an @antelopejs/interface-* package.",
    },
    messages: {
      instanceofInterface:
        "instanceof {{name}} is false for a {{name}} built by another copy of its interface package. Use the package brand guard (for example IsStream), or add one next to {{name}}.",
    },
  },
  createOnce(context) {
    const exported = new Set<string>();
    function definitionOf(identifier: ESTree.IdentifierReference) {
      return resolveVariable(context.sourceCode, identifier)?.defs[0];
    }
    function isOwnExportedClass(identifier: ESTree.IdentifierReference) {
      const variable = resolveVariable(context.sourceCode, identifier);
      return (
        variable?.scope.block.type === "Program" &&
        variable.defs[0]?.type === "ClassName" &&
        exported.has(identifier.name)
      );
    }
    return {
      Program(program) {
        exported.clear();
        const owner = enclosingPackage(context.filename)?.manifest.name;
        if (owner === undefined || !INTERFACE_PACKAGE.test(owner)) return;
        for (const statement of program.body)
          for (const name of exportedNames(statement)) exported.add(name);
      },
      BinaryExpression(node) {
        if (node.operator !== "instanceof") return;
        const right = unwrapExpression(node.right);
        let name: string | null = null;
        if (right.type === "Identifier") {
          const definition = definitionOf(right);
          if (
            (definition !== undefined && importedFromInterface(definition)) ||
            isOwnExportedClass(right)
          )
            name = right.name;
        } else if (
          right.type === "MemberExpression" &&
          !right.computed &&
          right.object.type === "Identifier" &&
          right.property.type === "Identifier"
        ) {
          const definition = definitionOf(right.object);
          if (
            definition?.node.type === "ImportNamespaceSpecifier" &&
            importedFromInterface(definition)
          )
            name = right.property.name;
        }
        if (name !== null)
          context.report({
            node: node.right,
            messageId: "instanceofInterface",
            data: { name },
          });
      },
    };
  },
});
