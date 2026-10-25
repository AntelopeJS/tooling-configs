import type { ESTree } from "@oxlint/plugins";

/** Test locations shared by the preset's assertion and test-quality rules. */
export const TEST_FILE_GLOBS = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
];

/** Assertion entry points recognized by both expect-expect and the function-only rule. */
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

/** Uses the same wildcard assertion names accepted by jest/expect-expect. */
export function isAssertionName(name: string): boolean {
  return ASSERTION_FUNCTION_NAMES.some((pattern) =>
    pattern.endsWith("*")
      ? name.startsWith(pattern.slice(0, -1))
      : name === pattern,
  );
}
