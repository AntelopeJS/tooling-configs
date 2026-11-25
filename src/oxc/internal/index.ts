import { defineRule, eslintCompatPlugin } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const TYPE_LISTS = new Set([
  "typeArguments",
  "typeParameters",
  "superTypeArguments",
]);

const MESSAGE =
  "Map a call argument to its parameter through argumentParameters(fn): a declared this takes params[0] but no argument.";

/** The function node whose `params` list `node` reads, or null for a type list or another member. */
function paramsOwner(node: ESTree.Node): ESTree.Node | null {
  if (
    node.type !== "MemberExpression" ||
    node.computed ||
    node.property.type !== "Identifier" ||
    node.property.name !== "params"
  )
    return null;
  const { object } = node;
  if (
    object.type === "MemberExpression" &&
    !object.computed &&
    object.property.type === "Identifier" &&
    TYPE_LISTS.has(object.property.name)
  )
    return null;
  return object;
}

const noParamsIndexing = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Reject computed or iterated function `params`, which a declared `this` shifts from the call arguments.",
    },
    messages: { shifted: MESSAGE },
  },
  createOnce(context) {
    const report = (node: ESTree.Node) =>
      context.report({ node, messageId: "shifted" });
    return {
      MemberExpression(node) {
        if (node.computed && paramsOwner(node.object) !== null) report(node);
        else if (
          node.object.type === "MemberExpression" &&
          paramsOwner(node.object) !== null &&
          node.parent.type === "CallExpression" &&
          node.parent.callee === node
        )
          report(node);
      },
      ForOfStatement(node) {
        if (paramsOwner(node.right) !== null) report(node.right);
      },
      SpreadElement(node) {
        if (paramsOwner(node.argument) !== null) report(node.argument);
      },
    };
  },
});

/** Rules for this repository's own lint only; never part of a published preset. */
export default eslintCompatPlugin({
  meta: { name: "tooling-internal" },
  rules: { "no-params-indexing": noParamsIndexing },
});
