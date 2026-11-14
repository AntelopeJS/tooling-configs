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

/** Whether `call` calls the first parameter after any `this` parameter of a function it sits in, as a `new Promise` executor calls its `resolve`. */
function callsFirstParameter(call: ESTree.CallExpression): boolean {
  const { callee } = call;
  if (callee.type !== "Identifier") return false;
  for (
    let fn = enclosingFunction(call);
    fn !== null;
    fn = enclosingFunction(fn)
  ) {
    const first = fn.params.find(
      (param) => param.type !== "Identifier" || param.name !== "this",
    );
    const name = first?.type === "AssignmentPattern" ? first.left : first;
    if (name?.type === "Identifier" && name.name === callee.name) return true;
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

/** Whether `type` is an interface-database `Table`, alone, extended or intersected, which a value holds as a handle to query later rather than as a query to run: only a table has that package's `insert()`. */
function isTable(checker: ts.TypeChecker, type: ts.Type): boolean {
  return declaredIn(
    checker.getPropertyOfType(type, "insert"),
    INTERFACE_DATABASE,
  );
}

/** Whether `type` is an object literal, an interface or object type the project declares, a mapped type such as `Readonly<T>` or `Record<K, V>`, or an intersection of those, as opposed to a class instance or a library type. */
function isHolder(type: ts.Type): boolean {
  if (type.isIntersection()) return type.types.every(isHolder);
  const symbol = type.getSymbol();
  if (symbol?.declarations?.some(ts.isMappedTypeNode) === true) return true;
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

/** The values an array, a tuple or a holder keeps in its properties and index signatures, which awaiting it leaves as they are. */
function heldValues(checker: ts.TypeChecker, type: ts.Type): ts.Type[] {
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    return element === undefined ? [] : [element];
  }
  if (!isHolder(type)) return [];
  return [
    ...checker
      .getPropertiesOfType(type)
      .map((property) => checker.getTypeOfSymbol(property)),
    ...checker.getIndexInfosOfType(type).map((info) => info.type),
  ];
}

/** Whether an array, a tuple or a holder of `type` keeps a query other than a table at any depth. */
function holdsHeldQuery(
  checker: ts.TypeChecker,
  type: ts.Type,
  visited: Set<ts.Type>,
): boolean {
  return heldValues(checker, type).some((value) =>
    members(value).some((member) => {
      if (isQuery(checker, member)) return !isTable(checker, member);
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

/** `expression` without the parentheses, `as`, `<T>`, `satisfies` and `!` around it. */
function unwrapped(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
    ? unwrapped(expression.expression)
    : expression;
}

/** The function a declaration holds: the initialiser of a variable or property, the value a shorthand property names, or the declaration itself. */
function declaredFunctions(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
): readonly ts.Node[] {
  if (ts.isShorthandPropertyAssignment(declaration))
    return (
      checker.getShorthandAssignmentValueSymbol(declaration)?.declarations ?? []
    ).flatMap((value) => declaredFunctions(checker, value));
  return (ts.isVariableDeclaration(declaration) ||
    ts.isPropertyDeclaration(declaration) ||
    ts.isPropertyAssignment(declaration)) &&
    declaration.initializer !== undefined
    ? [unwrapped(declaration.initializer)]
    : [declaration];
}

/** The declarations of member `access` on the value its receiver variable is initialised with, past any type annotation that names only a signature. */
function initialisedMember(
  checker: ts.TypeChecker,
  access: ts.PropertyAccessExpression,
): readonly ts.Declaration[] {
  const receiver = ts.isIdentifier(access.expression)
    ? checker.getSymbolAtLocation(access.expression)?.valueDeclaration
    : undefined;
  return receiver !== undefined &&
    ts.isVariableDeclaration(receiver) &&
    receiver.initializer !== undefined
    ? (checker
        .getTypeAtLocation(unwrapped(receiver.initializer))
        .getProperty(access.name.text)?.declarations ?? [])
    : [];
}

/** The functions a `new Promise` argument names: the function written there, or each declaration, overloads included, or initialiser of the variable, property or method its identifier or member access resolves to. */
function namedFunctions(
  checker: ts.TypeChecker,
  argument: ts.Expression,
): readonly ts.Node[] {
  const value = unwrapped(argument);
  if (ts.isFunctionExpression(value) || ts.isArrowFunction(value))
    return [value];
  if (!ts.isIdentifier(value) && !ts.isPropertyAccessExpression(value))
    return [];
  return [
    ...(checker.getSymbolAtLocation(value)?.declarations ?? []),
    ...(ts.isPropertyAccessExpression(value)
      ? initialisedMember(checker, value)
      : []),
  ].flatMap((declaration) => declaredFunctions(checker, declaration));
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
    for (const executor of argument ? namedFunctions(checker, argument) : [])
      executors.add(executor);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  executorsByFile.set(sourceFile, executors);
  return executors;
}

/** The value `call` resolves its promise with, when its callee is the first parameter after any `this` parameter of a function the file hands to `new Promise` as its executor. */
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
    executor.parameters.find(
      ({ name }) => !ts.isIdentifier(name) || name.text !== "this",
    ) === parameter &&
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
