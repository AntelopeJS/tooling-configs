import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

type TypeAssertionExpression = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

function isTypeAssertionExpression(node: ESTree.Node): node is TypeAssertionExpression {
  return node.type === "TSAsExpression" || node.type === "TSTypeAssertion";
}

function unwrapParenthesizedExpression(expression: ESTree.Expression): ESTree.Expression {
  let current = expression;
  while (current.type === "ParenthesizedExpression") {
    current = current.expression;
  }
  return current;
}

function unwrapParenthesizedType(type: ESTree.TSType): ESTree.TSType {
  let current = type;
  while (current.type === "TSParenthesizedType") current = current.typeAnnotation;
  return current;
}

function instanceClassName(thisExpression: ESTree.ThisExpression): string | null {
  let scope: ESTree.Node = thisExpression.parent;
  while (scope.type !== "FunctionExpression") {
    if (
      scope.type === "Program" ||
      scope.type === "FunctionDeclaration" ||
      scope.type === "ClassBody"
    ) {
      return null;
    }
    scope = scope.parent;
  }
  const declaresThis = scope.params.some(
    (parameter) => parameter.type === "Identifier" && parameter.name === "this",
  );
  const method = scope.parent;
  if (declaresThis || method.type !== "MethodDefinition" || method.static) return null;
  const owner = method.parent.parent;
  if (owner?.type !== "ClassDeclaration" && owner?.type !== "ClassExpression") return null;
  return owner.id?.name ?? null;
}

function isPhantomRetypeOfThis(node: TypeAssertionExpression): boolean {
  const target = unwrapParenthesizedType(node.typeAnnotation);
  const inner = unwrapParenthesizedExpression(node.expression);
  if (
    target.type !== "TSTypeReference" ||
    target.typeName.type !== "Identifier" ||
    (target.typeArguments?.params.length ?? 0) === 0 ||
    !isTypeAssertionExpression(inner) ||
    unwrapParenthesizedType(inner.typeAnnotation).type !== "TSUnknownKeyword"
  ) {
    return false;
  }
  const source = unwrapParenthesizedExpression(inner.expression);
  return source.type === "ThisExpression" && instanceClassName(source) === target.typeName.name;
}

function isConstAssertion(node: TypeAssertionExpression): boolean {
  const { typeAnnotation } = node;
  return (
    typeAnnotation.type === "TSTypeReference" &&
    typeAnnotation.typeName.type === "Identifier" &&
    typeAnnotation.typeName.name === "const"
  );
}

function isOutermostAssertionInChain(node: TypeAssertionExpression): boolean {
  let current: ESTree.Expression = node;
  let parent = node.parent;

  while (parent.type === "ParenthesizedExpression" && parent.expression === current) {
    current = parent;
    parent = parent.parent;
  }

  return !isTypeAssertionExpression(parent) || parent.expression !== current;
}

function isForbiddenAssertionChain(node: TypeAssertionExpression): boolean {
  let assertionCount = 0;
  let hasNonConstAssertion = false;
  let current: ESTree.Expression = node;

  while (isTypeAssertionExpression(current)) {
    assertionCount += 1;
    hasNonConstAssertion ||= !isConstAssertion(current);
    current = unwrapParenthesizedExpression(current.expression);
  }

  return assertionCount > 1 && hasNonConstAssertion && !isPhantomRetypeOfThis(node);
}

/**
 * Disallow nested TypeScript type assertions. Chains made only of const assertions pass, and so
 * does `this as unknown as C<...>` in a non-static method of class `C`: the same instance under
 * other type arguments, which TypeScript cannot express in one step when `C` is invariant in a
 * phantom type parameter. require-safety-comment-for-type-assertion still asks it to state why the
 * parameter holds no value.
 */
export const noChainedTypeAssertionsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow chained TypeScript as and angle-bracket assertions, including parenthesized chains, except `this as unknown as C<...>` in a non-static method of class C.",
    },
    messages: {
      chained:
        "This assertion chain discards type evidence. Keep the original precise type, or parse untrusted input at its boundary before narrowing it.",
    },
  },
  createOnce(context) {
    const checkTypeAssertion = (node: TypeAssertionExpression) => {
      if (!isOutermostAssertionInChain(node) || !isForbiddenAssertionChain(node)) return;
      context.report({ node, messageId: "chained" });
    };

    return {
      TSAsExpression: checkTypeAssertion,
      TSTypeAssertion: checkTypeAssertion,
    };
  },
});
