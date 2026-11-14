import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defineRule } from "@oxlint/plugins";
import ts from "@typescript/typescript6";

import type { ESTree } from "@oxlint/plugins";
import { memberName } from "../shared.ts";
import { nodeAt, typedFile } from "../type-checker.ts";
import type { TypedFile } from "../type-checker.ts";

type FunctionNode = ESTree.Function | ESTree.ArrowFunctionExpression;

const PACKAGE = "node_modules/@antelopejs/interface-database";
const INTERFACE_DATABASE = `/${PACKAGE}/`;
const PROMISE_CALLBACK_METHODS = new Set(["then", "catch", "finally"]);

const PNPM_ENTRY = "@antelopejs+interface-database@";

const installs = new Map<string, boolean>();

/** Whether `directory` installs interface-database: linked at `node_modules/@antelopejs`, or only in pnpm's store as a transitive dependency. A store it cannot read counts as installing it, so the rule falls back to the type check. */
function installedIn(directory: string): boolean {
  if (existsSync(join(directory, PACKAGE))) return true;
  const store = join(directory, "node_modules/.pnpm");
  try {
    return readdirSync(store).some((entry) => entry.startsWith(PNPM_ENTRY));
  } catch {
    return existsSync(store);
  }
}

/** Whether a `node_modules` at or above `directory` installs interface-database, so a repository without it never builds a type-checked program for this rule. */
function installsInterfaceDatabase(directory: string): boolean {
  const known = installs.get(directory);
  if (known !== undefined) return known;
  const parent = dirname(directory);
  const found =
    installedIn(directory) ||
    (parent !== directory && installsInterfaceDatabase(parent));
  installs.set(directory, found);
  return found;
}

function isFunction(node: ESTree.Node): node is FunctionNode {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

function enclosingFunction(node: ESTree.Node): FunctionNode | null {
  for (let current = node.parent; current !== null; current = current.parent)
    if (isFunction(current)) return current;
  return null;
}

/** Whether `call` hands its arguments to a promise that awaits what they return: `then`, `catch` or `finally`. */
function isPromiseCallback(call: ESTree.CallExpression): boolean {
  return (
    call.callee.type === "MemberExpression" &&
    PROMISE_CALLBACK_METHODS.has(memberName(call.callee) ?? "")
  );
}

/** Whether the caller awaits what the function returns: an async function, or a callback handed to `then`, `catch` or `finally`. */
function resultIsAwaited(fn: FunctionNode): boolean {
  if (fn.async) return true;
  const call = fn.parent;
  return (
    call?.type === "CallExpression" &&
    call.arguments.some((argument) => argument === fn) &&
    isPromiseCallback(call)
  );
}

/** Whether `call` sits inside the executor function of a `new Promise`, where it may call that executor's `resolve`. */
function inPromiseExecutor(call: ESTree.CallExpression): boolean {
  for (
    let fn = enclosingFunction(call);
    fn !== null;
    fn = enclosingFunction(fn)
  )
    if (
      fn.parent?.type === "NewExpression" &&
      fn.parent.callee.type === "Identifier" &&
      fn.parent.callee.name === "Promise" &&
      fn.parent.arguments[0] === fn
    )
      return true;
  return false;
}

/** Whether `type` is an interface-database query: its `run()` comes from that package. */
function isQuery(checker: ts.TypeChecker, type: ts.Type): boolean {
  return (
    checker
      .getPropertyOfType(type, "run")
      ?.declarations?.some((declaration) =>
        declaration.getSourceFile().fileName.includes(INTERFACE_DATABASE),
      ) === true
  );
}

function members(type: ts.Type): readonly ts.Type[] {
  return type.isUnion() ? type.types : [type];
}

/** The values an array, a tuple or an object literal holds, which awaiting it leaves as they are. */
function heldValues(checker: ts.TypeChecker, type: ts.Type): ts.Type[] {
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    return element === undefined ? [] : [element];
  }
  return (type.getSymbol()?.flags ?? 0) & ts.SymbolFlags.ObjectLiteral
    ? checker
        .getPropertiesOfType(type)
        .map((property) => checker.getTypeOfSymbol(property))
    : [];
}

/** Whether an awaiting caller receives an unrun query from a value of `type`: the query itself, possibly behind a promise, or one an array, a tuple or an object literal holds. */
function holdsQuery(checker: ts.TypeChecker, type: ts.Type): boolean {
  const isQueryMember = (value: ts.Type) =>
    members(value).some((member) => isQuery(checker, member));
  return members(checker.getAwaitedType(type) ?? type).some(
    (member) =>
      isQuery(checker, member) ||
      heldValues(checker, member).some(isQueryMember),
  );
}

/** What a function value handed to `then`, `catch` or `finally` resolves the promise to: the return types of its non-async call signatures, since an async one reports its own returns. */
function callbackResult(
  checker: ts.TypeChecker,
  callback: ts.Expression,
): ts.Type[] {
  return checker
    .getTypeAtLocation(callback)
    .getCallSignatures()
    .filter(
      ({ declaration }) =>
        declaration === undefined ||
        (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Async) ===
          0,
    )
    .map((signature) => checker.getReturnTypeOfSignature(signature));
}

/** The value `call` resolves its promise with, when its callee is the first parameter of a `new Promise` executor. */
function resolvedValue(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
): ts.Expression | undefined {
  const parameter = checker.getSymbolAtLocation(
    call.expression,
  )?.valueDeclaration;
  const executor = parameter?.parent;
  const construction = executor?.parent;
  return parameter !== undefined &&
    ts.isParameter(parameter) &&
    executor !== undefined &&
    ts.isFunctionLike(executor) &&
    executor.parameters[0] === parameter &&
    construction !== undefined &&
    ts.isNewExpression(construction) &&
    construction.arguments?.[0] === executor &&
    ts.isIdentifier(construction.expression) &&
    construction.expression.text === "Promise"
    ? call.arguments[0]
    : undefined;
}

/** Since interface-database 0.4.0 a query is no longer thenable, so an awaited function that returns one, alone or wrapped, resolves to the unrun query and sends nothing. */
export const noUnrunQueryRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "An async function, promise callback or promise executor resolves to no unrun interface-database query.",
    },
    messages: {
      unrun:
        "This resolves to an interface-database query without running it, so the caller awaits the query object and nothing reaches the database. Call `.run()` on it.",
    },
  },
  createOnce(context) {
    function check(
      value: ESTree.Node,
      resolved: (typed: TypedFile) => readonly ts.Type[],
    ): void {
      if (!installsInterfaceDatabase(dirname(resolve(context.filename))))
        return;
      const typed = typedFile(context.filename, context.sourceCode.text);
      if (
        typed !== undefined &&
        resolved(typed).some((type) => holdsQuery(typed.checker, type))
      )
        context.report({ node: value, messageId: "unrun" });
    }
    function typeOf(
      node: ts.Node | undefined,
      { checker }: TypedFile,
    ): ts.Type[] {
      return node === undefined ? [] : [checker.getTypeAtLocation(node)];
    }
    return {
      ReturnStatement(node) {
        const fn = enclosingFunction(node);
        if (fn === null || node.argument === null || !resultIsAwaited(fn))
          return;
        check(node.argument, (typed) =>
          typeOf(
            nodeAt(typed.sourceFile, node, ts.isReturnStatement)?.expression,
            typed,
          ),
        );
      },
      ArrowFunctionExpression(node) {
        if (node.body.type === "BlockStatement" || !resultIsAwaited(node))
          return;
        check(node.body, (typed) =>
          typeOf(
            nodeAt(typed.sourceFile, node, ts.isArrowFunction)?.body,
            typed,
          ),
        );
      },
      CallExpression(node) {
        if (isPromiseCallback(node))
          for (const argument of node.arguments)
            if (!isFunction(argument))
              check(argument, (typed) => {
                const callback = nodeAt(
                  typed.sourceFile,
                  argument,
                  ts.isExpression,
                );
                return callback === undefined
                  ? []
                  : callbackResult(typed.checker, callback);
              });
        const [value] = node.arguments;
        if (
          node.callee.type === "Identifier" &&
          value !== undefined &&
          inPromiseExecutor(node)
        )
          check(value, (typed) => {
            const call = nodeAt(typed.sourceFile, node, ts.isCallExpression);
            return typeOf(call && resolvedValue(typed.checker, call), typed);
          });
      },
    };
  },
});
