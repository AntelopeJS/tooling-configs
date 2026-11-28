import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";
import { callName, testCallback } from "../shared.ts";

const PROPERTY_RUNNERS = new Set(["fc.assert", "fc.check"]);
const NON_MOCHA_RUNNERS = new Set(["vitest", "node:test", "bun:test"]);
const DESCRIBE = /^(?:describe|context|suite)(?:\.(?:only|skip))?$/u;

type Callback = ESTree.ArrowFunctionExpression | ESTree.Function;

/** A test or describe callback and the argument of the `this.timeout(n)` it calls, once one is seen. */
interface Frame {
  node: ESTree.CallExpression;
  callback: Callback;
  test: boolean;
  timeout: ESTree.Argument | undefined;
  runsProperty: boolean;
}

function describeCallback(node: ESTree.CallExpression): Callback | undefined {
  const name = callName(node.callee);
  if (name === null || !DESCRIBE.test(name)) return undefined;
  return node.arguments.find(
    (argument): argument is Callback =>
      argument.type === "ArrowFunctionExpression" ||
      argument.type === "FunctionExpression",
  );
}

/** The function whose `this` a node sees: arrow functions pass it through. */
function thisOwner(node: ESTree.Node): ESTree.Node | null {
  let current = node.parent;
  while (current !== null && current.type !== "FunctionExpression") {
    if (current.type === "FunctionDeclaration") return current;
    current = current.parent;
  }
  return current;
}

function isThisTimeout(node: ESTree.CallExpression): boolean {
  return (
    node.callee.type === "MemberExpression" &&
    node.callee.object.type === "ThisExpression" &&
    !node.callee.computed &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === "timeout"
  );
}

function isZero(node: ESTree.Argument | undefined): boolean {
  return node?.type === "Literal" && node.value === 0;
}

/** A mocha test that calls `fc.assert` or `fc.check` runs at `this.timeout(0)`, set in its callback or in the nearest enclosing describe that sets a timeout. */
export const propertyTestTimeoutRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require `this.timeout(0)` on a mocha test that runs a fast-check property.",
    },
    messages: {
      timed:
        "A property runs a fixed number of runs whose time depends on the host's load, so a mocha timeout of {{ timer }} fails it on a busy runner and leaves it running into later tests. Call `this.timeout(0)` in this test or its describe: `numRuns` bounds it, and the CI job's timeout-minutes ends a hang.",
    },
  },
  createOnce(context) {
    const frames: Frame[] = [];
    let mocha = true;
    function timer(): string | null {
      for (let index = frames.length - 1; index >= 0; index -= 1) {
        const frame = frames[index];
        if (frame?.timeout !== undefined)
          return isZero(frame.timeout)
            ? null
            : context.sourceCode.getText(frame.timeout);
      }
      return "the default";
    }
    return {
      before() {
        frames.length = 0;
        mocha = true;
      },
      ImportDeclaration(node) {
        if (NON_MOCHA_RUNNERS.has(node.source.value)) mocha = false;
      },
      CallExpression(node) {
        const test = testCallback(node);
        const callback = test ?? describeCallback(node);
        if (callback !== undefined) {
          frames.push({
            node,
            callback,
            test: test !== undefined,
            timeout: undefined,
            runsProperty: false,
          });
          return;
        }
        const frame = frames.at(-1);
        if (frame === undefined) return;
        if (isThisTimeout(node) && thisOwner(node) === frame.callback) {
          frame.timeout = node.arguments[0];
        }
        const name = callName(node.callee);
        if (name !== null && PROPERTY_RUNNERS.has(name))
          frame.runsProperty = true;
      },
      "CallExpression:exit"(node) {
        const frame = frames.at(-1);
        if (frame?.node !== node) return;
        const found = frame.test && frame.runsProperty ? timer() : null;
        frames.pop();
        if (mocha && found !== null)
          context.report({ node, messageId: "timed", data: { timer: found } });
      },
    };
  },
});
