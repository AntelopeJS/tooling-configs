import type { ESTree } from "@oxlint/plugins";

/** Test locations shared by the preset's assertion and test-quality rules. */
export const TEST_FILE_GLOBS = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
];

/** Assertion entry points recognized by the assertion and function-only rules. */
export const ASSERTION_FUNCTION_NAMES = [
  "expect",
  "assert",
  "assert.*",
  "assert*",
  "expect*",
];

/** Static property names include quoted computed access, but never dynamic keys. */
export function memberName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) {
    return node.property.type === "Identifier" ? node.property.name : null;
  }
  return node.property.type === "Literal" && !("regex" in node.property)
    ? String(node.property.value)
    : null;
}

/** A statically named callee, such as expect, assert.equal, or test.concurrent.only. */
export function callName(node: ESTree.Expression): string | null {
  if (node.type === "Identifier") return node.name;
  if (node.type !== "MemberExpression") return null;
  const owner = callName(node.object);
  const name = memberName(node);
  return owner !== null && name !== null ? `${owner}.${name}` : null;
}

/** The expect call and matcher path in expect(value).to.deep.equal(expected). */
export function matcherChain(node: ESTree.CallExpression) {
  const chain: string[] = [];
  let current = node.callee;
  while (current.type === "MemberExpression") {
    const name = memberName(current);
    if (name === null) return null;
    chain.unshift(name);
    current = current.object;
  }
  if (
    current.type !== "CallExpression" ||
    callName(current.callee) !== "expect"
  ) {
    return null;
  }
  return { expect: current, matcher: chain.join(".") };
}

function isAssertionName(name: string): boolean {
  return ASSERTION_FUNCTION_NAMES.some((pattern) =>
    pattern.endsWith("*")
      ? name.startsWith(pattern.slice(0, -1))
      : name === pattern,
  );
}

/** Assertion syntax shared by both test-quality rules, including fluent assertion libraries. */
export function isAssertion(
  node: ESTree.CallExpression | ESTree.MemberExpression,
): boolean {
  if (node.type === "MemberExpression") return memberName(node) === "should";
  const name = callName(node.callee);
  return (
    (name !== null &&
      (isAssertionName(name) ||
        name.startsWith("sinon.assert.") ||
        name === "should")) ||
    (node.callee.type === "MemberExpression" &&
      memberName(node.callee) === "expect")
  );
}

/** Executable inline callbacks for it/test, excluding skipped and todo registrations. */
export function testCallback(node: ESTree.CallExpression) {
  const name = callName(node.callee);
  if (
    name === null ||
    !/^(?:it|test)(?:\.(?:only|concurrent|serial|fails|skip|todo))*$/u.test(
      name,
    ) ||
    /\.(?:skip|todo)(?:\.|$)/u.test(name)
  )
    return undefined;
  for (const argument of node.arguments) {
    if (
      argument.type === "ArrowFunctionExpression" ||
      argument.type === "FunctionExpression"
    )
      return argument;
  }
  return undefined;
}
