import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";
import { enclosingPackage } from "../self-package.ts";
import { unwrapExpression } from "../local-types.ts";

const INTERFACE_PACKAGE = /^@antelopejs\/interface-[^/]+/;

function importedFromInterface(declaration: ESTree.ImportDeclaration) {
  return (
    declaration.importKind !== "type" &&
    INTERFACE_PACKAGE.test(declaration.source.value)
  );
}

function collectSpecifiers(
  declaration: ESTree.ImportDeclaration,
  imported: Set<string>,
  namespaces: Set<string>,
) {
  for (const specifier of declaration.specifiers) {
    if (specifier.type === "ImportNamespaceSpecifier")
      namespaces.add(specifier.local.name);
    else if (
      specifier.type !== "ImportSpecifier" ||
      specifier.importKind !== "type"
    )
      imported.add(specifier.local.name);
  }
}

function exportedClassName(statement: ESTree.Node): string | null {
  if (
    statement.type !== "ExportNamedDeclaration" &&
    statement.type !== "ExportDefaultDeclaration"
  )
    return null;
  const { declaration } = statement;
  return declaration?.type === "ClassDeclaration" && declaration.id !== null
    ? declaration.id.name
    : null;
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
    const imported = new Set<string>();
    const namespaces = new Set<string>();
    const own = new Set<string>();
    return {
      Program(program) {
        imported.clear();
        namespaces.clear();
        own.clear();
        for (const statement of program.body) {
          if (
            statement.type === "ImportDeclaration" &&
            importedFromInterface(statement)
          )
            collectSpecifiers(statement, imported, namespaces);
        }
        const owner = enclosingPackage(context.filename)?.manifest.name;
        if (owner === undefined || !INTERFACE_PACKAGE.test(owner)) return;
        for (const statement of program.body) {
          const name = exportedClassName(statement);
          if (name !== null) own.add(name);
        }
      },
      BinaryExpression(node) {
        if (node.operator !== "instanceof") return;
        const right = unwrapExpression(node.right);
        let name: string | null = null;
        if (right.type === "Identifier")
          name =
            imported.has(right.name) || own.has(right.name) ? right.name : null;
        else if (
          right.type === "MemberExpression" &&
          !right.computed &&
          right.object.type === "Identifier" &&
          namespaces.has(right.object.name) &&
          right.property.type === "Identifier"
        )
          name = right.property.name;
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
