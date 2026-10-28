import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";
import {
  enclosingPackage,
  exportsCover,
  isSelfLinked,
  selfSubpath,
} from "../self-package.ts";

/** A test that imports its own package name must reach local code: the `exports` map publishes the subpath and `node_modules` links the package to itself. */
export const noSelfImportInTestsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Tests import the module under test from local source, never their own published package name.",
    },
    messages: {
      selfImport:
        "This test imports its own package `{{ name }}`, which resolves to the installed published copy, so it never exercises the local code. Import the module under test by relative path, or make the self-import local: publish `{{ subpath }}` in package.json `exports` and link the package to itself (`link:.` in devDependencies).",
    },
  },
  createOnce(context) {
    function check(node: ESTree.Node, specifier: string): void {
      const owner = enclosingPackage(context.filename);
      if (owner === undefined) return;
      const { directory, manifest } = owner;
      const subpath = selfSubpath(manifest.name, specifier);
      if (
        subpath === undefined ||
        (exportsCover(manifest.exports, subpath) &&
          isSelfLinked(directory, manifest.name))
      )
        return;
      context.report({
        node,
        messageId: "selfImport",
        data: { name: manifest.name, subpath },
      });
    }
    return {
      ImportDeclaration(node) {
        if (
          node.importKind === "type" ||
          (node.specifiers.length > 0 &&
            node.specifiers.every(
              (specifier) =>
                specifier.type === "ImportSpecifier" &&
                specifier.importKind === "type",
            ))
        )
          return;
        check(node, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source && node.exportKind !== "type")
          check(node, node.source.value);
      },
      ExportAllDeclaration(node) {
        if (node.exportKind !== "type") check(node, node.source.value);
      },
      ImportExpression(node) {
        if (node.source.type === "Literal" && !("regex" in node.source))
          check(node, String(node.source.value));
      },
      TSImportEqualsDeclaration(node) {
        const reference = node.moduleReference;
        if (
          node.importKind !== "type" &&
          reference.type === "TSExternalModuleReference"
        )
          check(node, reference.expression.value);
      },
      CallExpression(node) {
        const [argument] = node.arguments;
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          argument?.type === "Literal" &&
          !("regex" in argument)
        )
          check(node, String(argument.value));
      },
    };
  },
});
