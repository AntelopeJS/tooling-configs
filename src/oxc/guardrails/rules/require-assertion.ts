import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";
import { isAssertion, testCallback } from "../shared.ts";

interface TestFrame {
  node: ESTree.CallExpression;
  callback: ESTree.ArrowFunctionExpression | ESTree.Function;
  hasAssertion: boolean;
}

/** Test callbacks must contain an assertion regardless of their framework or filename. */
export const requireAssertionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Require an assertion in every executable test callback.",
    },
    messages: {
      missingAssertion:
        "Call an assertion in this test to verify its behavior.",
    },
  },
  createOnce(context) {
    const frames: TestFrame[] = [];
    function recordAssertion(
      node: ESTree.CallExpression | ESTree.MemberExpression,
    ) {
      const frame = frames.at(-1);
      if (
        frame !== undefined &&
        node.start >= frame.callback.start &&
        node.end <= frame.callback.end &&
        isAssertion(node)
      )
        frame.hasAssertion = true;
    }
    return {
      before() {
        frames.length = 0;
      },
      CallExpression(node) {
        const callback = testCallback(node);
        if (callback !== undefined) {
          frames.push({ node, callback, hasAssertion: false });
        } else {
          recordAssertion(node);
        }
      },
      MemberExpression: recordAssertion,
      "CallExpression:exit"(node) {
        const frame = frames.at(-1);
        if (frame?.node !== node) return;
        frames.pop();
        if (!frame.hasAssertion)
          context.report({ node, messageId: "missingAssertion" });
      },
    };
  },
});
