import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";
import { matcherChain } from "../shared.ts";

const equalityMatchers = new Set([
  "toBe",
  "toEqual",
  "toStrictEqual",
  "to.equal",
  "to.eq",
  "eql",
  "to.eql",
  "to.deep.eq",
  "to.deep.equal",
  "to.be.equal",
]);
const constantName = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;

function isConstant(node: ESTree.Argument | undefined): boolean {
  if (node?.type === "Identifier") return constantName.test(node.name);
  if (node?.type !== "MemberExpression") return false;
  return isConstant(node.object);
}

function isLiteralValue(node: ESTree.Node): boolean {
  if (node.type === "Literal") {
    return !("regex" in node) && !("bigint" in node);
  }
  if (node.type === "TemplateLiteral") return node.expressions.length === 0;
  if (node.type === "UnaryExpression") {
    return (
      node.operator === "-" &&
      node.argument.type === "Literal" &&
      Number.isFinite(node.argument.value)
    );
  }
  if (node.type === "ArrayExpression") {
    return node.elements.every(
      (element) => element !== null && isLiteralValue(element),
    );
  }
  if (node.type === "ObjectExpression") {
    return node.properties.every(
      (property) =>
        property.type === "Property" &&
        !property.computed &&
        !property.method &&
        !property.shorthand &&
        property.kind === "init" &&
        isLiteralValue(property.value),
    );
  }
  return false;
}

/** Constant declarations already specify their values; tests must assert the behavior they drive. */
export const noConstantValueAssertionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow assertions that only restate a constant's literal value.",
    },
    messages: {
      constant:
        "A test that restates a constant fails only when someone edits the constant on purpose. Assert the behaviour the constant drives.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const chain = matcherChain(node);
        const expected = node.arguments[0];
        if (
          chain !== null &&
          equalityMatchers.has(chain.matcher) &&
          isConstant(chain.expect.arguments[0]) &&
          expected !== undefined &&
          isLiteralValue(expected)
        ) {
          context.report({ node, messageId: "constant" });
        }
      },
    };
  },
});
