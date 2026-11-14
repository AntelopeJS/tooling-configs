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

/** Whether `call` calls the first parameter of a function it sits in, as a `new Promise` executor calls its `resolve`. */
function callsFirstParameter(call: ESTree.CallExpression): boolean {
  const { callee } = call;
  if (callee.type !== "Identifier") return false;
  for (
    let fn = enclosingFunction(call);
    fn !== null;
    fn = enclosingFunction(fn)
  ) {
    const [first] = fn.params;
    if (first?.type === "Identifier" && first.name === callee.name) return true;
  }
  return false;
}

const HOLDERS =
  ts.SymbolFlags.ObjectLiteral |
  ts.SymbolFlags.Interface |
  ts.SymbolFlags.TypeLiteral;

function declaredIn(symbol: ts.Symbol | undefined, path: string): boolean {
  return (
    symbol?.declarations?.some((declaration) =>
      declaration.getSourceFile().fileName.includes(path),
    ) === true
  );
}

/** Whether `type` is an interface-database query: its `run()` comes from that package. */
function isQuery(checker: ts.TypeChecker, type: ts.Type): boolean {
  return declaredIn(checker.getPropertyOfType(type, "run"), INTERFACE_DATABASE);
}

/** Whether `type` is an interface-database `Table`, which a value holds as a handle to query later rather than as a query to run. */
function isTable(type: ts.Type): boolean {
  const symbol = type.getSymbol();
  return symbol?.name === "Table" && declaredIn(symbol, INTERFACE_DATABASE);
}

/** Whether `type` is an object literal, or an interface or object type the project declares, as opposed to a class instance or a library type. */
function isHolder(type: ts.Type): boolean {
  const symbol = type.getSymbol();
  return (
    symbol !== undefined &&
    (symbol.flags & HOLDERS) !== 0 &&
    (symbol.flags & ts.SymbolFlags.Class) === 0 &&
    !declaredIn(symbol, "/node_modules/")
  );
}

function members(type: ts.Type): readonly ts.Type[] {
  return type.isUnion() ? type.types : [type];
}

/** The values an array, a tuple or a holder keeps, which awaiting it leaves as they are. */
function heldValues(checker: ts.TypeChecker, type: ts.Type): ts.Type[] {
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    return element === undefined ? [] : [element];
  }
  return isHolder(type)
    ? checker
        .getPropertiesOfType(type)
        .map((property) => checker.getTypeOfSymbol(property))
    : [];
}

/** Whether an array, a tuple or a holder of `type` keeps a query other than a table at any depth. */
function holdsHeldQuery(
  checker: ts.TypeChecker,
  type: ts.Type,
  visited: Set<ts.Type>,
): boolean {
  return heldValues(checker, type).some((value) =>
    members(value).some((member) => {
      if (isQuery(checker, member)) return !isTable(member);
      if (visited.has(member)) return false;
      visited.add(member);
      return holdsHeldQuery(checker, member, visited);
    }),
  );
}

/** Whether an awaiting caller receives an unrun query from a value of `type`: the query itself, possibly behind a promise, or a query other than a table that arrays, tuples, object literals and project-declared object types keep. */
function holdsQuery(checker: ts.TypeChecker, type: ts.Type): boolean {
  const visited = new Set<ts.Type>();
  return members(checker.getAwaitedType(type) ?? type).some(
    (member) =>
      isQuery(checker, member) || holdsHeldQuery(checker, member, visited),
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

const executorsByFile = new WeakMap<ts.SourceFile, Set<ts.Node>>();

/** The function a `new Promise` argument names: the function written there, or the function declaration or initialised variable its identifier resolves to. */
function namedFunction(
  checker: ts.TypeChecker,
  argument: ts.Expression,
): ts.Node | undefined {
  if (ts.isFunctionExpression(argument) || ts.isArrowFunction(argument))
    return argument;
  if (!ts.isIdentifier(argument)) return undefined;
  const declaration = checker.getSymbolAtLocation(argument)?.valueDeclaration;
  return declaration !== undefined &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined
    ? declaration.initializer
    : declaration;
}

/** The functions `sourceFile` hands to `new Promise` as its executor, inline or by name. */
function promiseExecutors(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): Set<ts.Node> {
  const known = executorsByFile.get(sourceFile);
  if (known !== undefined) return known;
  const executors = new Set<ts.Node>();
  const visit = (node: ts.Node): void => {
    const argument =
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Promise"
        ? node.arguments?.[0]
        : undefined;
    const executor = argument && namedFunction(checker, argument);
    if (executor !== undefined) executors.add(executor);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  executorsByFile.set(sourceFile, executors);
  return executors;
}

/** The value `call` resolves its promise with, when its callee is the first parameter of a function the file hands to `new Promise` as its executor. */
function resolvedValue(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
): ts.Expression | undefined {
  const parameter = checker.getSymbolAtLocation(
    call.expression,
  )?.valueDeclaration;
  const executor = parameter?.parent;
  return parameter !== undefined &&
    ts.isParameter(parameter) &&
    executor !== undefined &&
    ts.isFunctionLike(executor) &&
    executor.parameters[0] === parameter &&
    promiseExecutors(checker, call.getSourceFile()).has(executor)
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
        if (value !== undefined && callsFirstParameter(node))
          check(value, (typed) => {
            const call = nodeAt(typed.sourceFile, node, ts.isCallExpression);
            return typeOf(call && resolvedValue(typed.checker, call), typed);
          });
      },
    };
  },
});
