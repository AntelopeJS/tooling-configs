import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";
import { callName, isAssertionName, matcherChain } from "../shared.ts";

const functionMatchers = new Set(["toBeTypeOf", "to.be.a", "to.be.an"]);
const typeofMatchers = new Set(["toBe", "to.equal"]);
const assertTypeofMatchers = new Set(["assert.equal", "assert.strictEqual"]);
const testName =
  /^(?:it|test)(?:\.(?:only|skip|concurrent|serial|todo|fails))*$/u;

function isTypeof(node: ESTree.Argument | undefined): boolean {
  return node?.type === "UnaryExpression" && node.operator === "typeof";
}

function isFunctionString(node: ESTree.Argument | undefined): boolean {
  return node?.type === "Literal" && node.value === "function";
}

function isFunctionCheck(node: ESTree.CallExpression): boolean {
  const name = callName(node.callee);
  if (name === "assert.isFunction") return true;
  if (name !== null && assertTypeofMatchers.has(name)) {
    return isTypeof(node.arguments[0]) && isFunctionString(node.arguments[1]);
  }
  let outer = node;
  while (
    outer.parent.type === "MemberExpression" &&
    outer.parent.object === outer
  ) {
    let member = outer.parent;
    while (
      member.parent.type === "MemberExpression" &&
      member.parent.object === member
    )
      member = member.parent;
    if (
      member.parent.type !== "CallExpression" ||
      member.parent.callee !== member
    )
      break;
    outer = member.parent;
  }
  const chain = matcherChain(outer);
  if (chain === null || !isFunctionString(outer.arguments[0])) return false;
  return (
    functionMatchers.has(chain.matcher) ||
    (typeofMatchers.has(chain.matcher) && isTypeof(chain.expect.arguments[0]))
  );
}

/** A test frame owns its callback and the assertions encountered within that callback. */
interface TestFrame {
  node: ESTree.CallExpression;
  callback: ESTree.ArrowFunctionExpression | ESTree.Function;
  assertions: boolean[];
}

/** Function existence alone is already a type-checker guarantee, not a behavioral test. */
export const noTypeofFunctionOnlyTestRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Require tests to do more than assert that functions exist.",
    },
    messages: {
      functionOnly:
        "The type checker already proves this. Call the function and assert what it returns or does.",
    },
  },
  createOnce(context) {
    const frames: TestFrame[] = [];
    return {
      before() {
        frames.length = 0;
      },
      CallExpression(node) {
        const name = callName(node.callee);
        const callback = node.arguments.find(
          (argument) =>
            argument.type === "ArrowFunctionExpression" ||
            argument.type === "FunctionExpression",
        );
        if (
          name !== null &&
          testName.test(name) &&
          callback !== undefined &&
          (callback.type === "ArrowFunctionExpression" ||
            callback.type === "FunctionExpression")
        ) {
          frames.push({ node, callback, assertions: [] });
          return;
        }
        const frame = frames.at(-1);
        if (
          frame === undefined ||
          node.start < frame.callback.start ||
          node.end > frame.callback.end ||
          name === null ||
          !isAssertionName(name)
        )
          return;
        frame.assertions.push(isFunctionCheck(node));
      },
      "CallExpression:exit"(node) {
        const frame = frames.at(-1);
        if (frame?.node !== node) return;
        frames.pop();
        if (frame.assertions.length > 0 && frame.assertions.every(Boolean)) {
          context.report({ node, messageId: "functionOnly" });
        }
      },
    };
  },
});
