import { defineRule } from "@oxlint/plugins";
import ts from "@typescript/typescript6";

import type { ESTree } from "@oxlint/plugins";
import { memberName } from "../shared.ts";
import { nodeAt, typedFile } from "../type-checker.ts";

type FunctionNode = ESTree.Function | ESTree.ArrowFunctionExpression;

const INTERFACE_DATABASE = "/node_modules/@antelopejs/interface-database/";
const PROMISE_CALLBACK_METHODS = new Set(["then", "catch", "finally"]);

function enclosingFunction(node: ESTree.Node): FunctionNode | null {
  for (let current = node.parent; current !== null; current = current.parent)
    if (
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression" ||
      current.type === "ArrowFunctionExpression"
    )
      return current;
  return null;
}

/** Whether the caller awaits what the function returns: an async function, or a callback handed to `then`, `catch` or `finally`. */
function resultIsAwaited(fn: FunctionNode): boolean {
  if (fn.async) return true;
  const call = fn.parent;
  return (
    call?.type === "CallExpression" &&
    call.arguments.some((argument) => argument === fn) &&
    call.callee.type === "MemberExpression" &&
    PROMISE_CALLBACK_METHODS.has(memberName(call.callee) ?? "")
  );
}

/** Whether `type` is an interface-database query: its `run()` comes from that package. */
function isQuery(checker: ts.TypeChecker, type: ts.Type): boolean {
  const members = type.isUnion() ? type.types : [type];
  return members.some((member) =>
    checker
      .getPropertyOfType(member, "run")
      ?.declarations?.some((declaration) =>
        declaration.getSourceFile().fileName.includes(INTERFACE_DATABASE),
      ),
  );
}

/** Since interface-database 0.4.0 a query is no longer thenable, so an awaited function that returns one resolves to the unrun query and sends nothing. */
export const noUnrunQueryRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "An async function or promise callback returns no unrun interface-database query.",
    },
    messages: {
      unrun:
        "This returns an interface-database query without running it, so the caller awaits the query object and nothing reaches the database. Call `.run()` on it.",
    },
  },
  createOnce(context) {
    function check(
      value: ESTree.Node,
      returned: (sourceFile: ts.SourceFile) => ts.Node | undefined,
    ): void {
      const typed = typedFile(context.filename, context.sourceCode.text);
      const expression = typed && returned(typed.sourceFile);
      if (
        typed !== undefined &&
        expression !== undefined &&
        isQuery(typed.checker, typed.checker.getTypeAtLocation(expression))
      )
        context.report({ node: value, messageId: "unrun" });
    }
    return {
      ReturnStatement(node) {
        const fn = enclosingFunction(node);
        if (fn === null || node.argument === null || !resultIsAwaited(fn))
          return;
        check(
          node.argument,
          (sourceFile) =>
            nodeAt(sourceFile, node, ts.isReturnStatement)?.expression,
        );
      },
      ArrowFunctionExpression(node) {
        if (node.body.type === "BlockStatement" || !resultIsAwaited(node))
          return;
        check(
          node.body,
          (sourceFile) => nodeAt(sourceFile, node, ts.isArrowFunction)?.body,
        );
      },
    };
  },
});
