import { readFileSync } from "node:fs";
import { defineRule } from "@oxlint/plugins";
import ts from "@typescript/typescript6";

import { typedFile, type TypedFile } from "../type-checker.ts";
import { declaresTypeParameters, scriptView } from "../vue-script.ts";

const UNTYPED = ts.TypeFlags.Any | ts.TypeFlags.Unknown;
const MAX_DEPTH = 4;

/** Which `typescript/no-unsafe-*` rule a finding stands in for. */
type Unsafe = "assignment" | "argument" | "return";

interface Finding {
  kind: Unsafe;
  node: ts.Node;
}

/** Whether `type` is `any` itself, not an error type from an import the program cannot resolve, such as another component. */
function isAnyType(checker: ts.TypeChecker, type: ts.Type): boolean {
  return type === checker.getAnyType();
}

function isAny(checker: ts.TypeChecker, node: ts.Node): boolean {
  return isAnyType(checker, checker.getTypeAtLocation(node));
}

function takesAnything(type: ts.Type | undefined): boolean {
  return type === undefined || (type.flags & UNTYPED) !== 0;
}

function elementType(
  checker: ts.TypeChecker,
  type: ts.Type,
): ts.Type | undefined {
  return checker.isArrayType(type) || checker.isTupleType(type)
    ? checker.getIndexTypeOfType(type, ts.IndexKind.Number)
    : undefined;
}

/**
 * Whether a `sender` value lets `any` into a `receiver` slot: `any` into a
 * slot that is undeclared or typed neither `any` nor `unknown`, or an array
 * or tuple holding `any`, as in `any[]`, into an array or tuple of the same
 * shape, one each is assignable to, with another element type.
 */
function leaks(
  checker: ts.TypeChecker,
  sender: ts.Type,
  receiver: ts.Type | undefined,
  depth = 0,
): boolean {
  if (isAnyType(checker, sender))
    return receiver === undefined || !takesAnything(receiver);
  if (
    receiver === undefined ||
    depth === MAX_DEPTH ||
    checker.isTupleType(sender) !== checker.isTupleType(receiver) ||
    !checker.isTypeAssignableTo(receiver, sender)
  )
    return false;
  const from = elementType(checker, sender);
  const to = elementType(checker, receiver);
  return (
    from !== undefined &&
    to !== undefined &&
    leaks(checker, from, to, depth + 1)
  );
}

/** Whether `value`, flowing into the slot its context declares, lets `any` in. */
function leaksIntoContext(
  checker: ts.TypeChecker,
  value: ts.Expression,
): boolean {
  return leaks(
    checker,
    checker.getTypeAtLocation(value),
    checker.getContextualType(value),
  );
}

/** Whether `literal` is the target of a destructuring assignment, as in `({ a } = value)`, whose elements name targets, not values. */
function isDestructuringTarget(literal: ts.Node): boolean {
  let child = literal;
  let parent = literal.parent;
  while (
    ts.isParenthesizedExpression(parent) ||
    ts.isArrayLiteralExpression(parent) ||
    ts.isObjectLiteralExpression(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isShorthandPropertyAssignment(parent) ||
    ts.isSpreadElement(parent) ||
    ts.isSpreadAssignment(parent)
  ) {
    child = parent;
    parent = parent.parent;
  }
  return (
    (ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.left === child) ||
    ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) &&
      parent.initializer === child)
  );
}

function declaredReturn(
  checker: ts.TypeChecker,
  node: ts.Node,
): ts.Type | undefined {
  let owner = node.parent;
  while (!ts.isFunctionLike(owner)) {
    if (ts.isSourceFile(owner)) return undefined;
    owner = owner.parent;
  }
  const contextual = ts.isExpression(owner)
    ? checker.getContextualType(owner)
    : undefined;
  const declared =
    owner.type === undefined
      ? contextual &&
        checker
          .getNonNullableType(contextual)
          .getCallSignatures()[0]
          ?.getReturnType()
      : checker.getTypeFromTypeNode(owner.type);
  const isAsync =
    ts.canHaveModifiers(owner) &&
    ts
      .getModifiers(owner)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
  return declared && isAsync ? checker.getAwaitedType(declared) : declared;
}

function argumentFindings(
  checker: ts.TypeChecker,
  call: ts.CallExpression | ts.NewExpression,
): Finding[] {
  return (call.arguments ?? []).flatMap((argument) => {
    const parameter = checker.getContextualType(argument);
    return ts.isSpreadElement(argument) ||
      parameter === undefined ||
      !leaks(checker, checker.getTypeAtLocation(argument), parameter)
      ? []
      : [{ kind: "argument", node: argument }];
  });
}

function returned(checker: ts.TypeChecker, value: ts.Expression): Finding[] {
  return leaks(
    checker,
    checker.getTypeAtLocation(value),
    declaredReturn(checker, value),
  )
    ? [{ kind: "return", node: value }]
    : [];
}

/** Whether `type` is `any` or an array of `any`, as a spread or rest holds it. */
function isAnyOrAnyArray(checker: ts.TypeChecker, type: ts.Type): boolean {
  const element = checker.isArrayType(type)
    ? elementType(checker, type)
    : undefined;
  return (
    isAnyType(checker, type) ||
    (element !== undefined && isAnyType(checker, element))
  );
}

function spreadFindings(
  checker: ts.TypeChecker,
  spread: ts.SpreadElement,
): Finding[] {
  const { parent } = spread;
  const anyCallee =
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    isAny(checker, parent.expression);
  return !anyCallee &&
    !isDestructuringTarget(parent) &&
    isAnyOrAnyArray(checker, checker.getTypeAtLocation(spread.expression))
    ? [
        {
          kind: ts.isArrayLiteralExpression(spread.parent)
            ? "assignment"
            : "argument",
          node: spread,
        },
      ]
    : [];
}

function propertyFindings(
  checker: ts.TypeChecker,
  property: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
): Finding[] {
  const value = ts.isPropertyAssignment(property)
    ? property.initializer
    : property.name;
  return !isDestructuringTarget(property.parent) &&
    leaksIntoContext(checker, value)
    ? [{ kind: "assignment", node: property }]
    : [];
}

/** A binding that takes an `any` its source declares, but for one whose default is itself reported, and the bindings nested under it. */
function elementFindings(
  checker: ts.TypeChecker,
  element: ts.BindingElement,
  source: ts.Type,
): Finding[] {
  if (isAnyType(checker, source))
    return element.initializer !== undefined &&
      isAny(checker, element.initializer)
      ? []
      : [{ kind: "assignment", node: element }];
  return ts.isIdentifier(element.name)
    ? []
    : destructuredFindings(checker, element.name, source);
}

/** The property or tuple slot named `key` that `source` declares, not one an index signature stands for. */
function declaredSlot(
  checker: ts.TypeChecker,
  source: ts.Type,
  key: string,
  at: ts.Node,
): ts.Type | undefined {
  const slot = checker.getPropertyOfType(source, key);
  return slot === undefined
    ? undefined
    : checker.getTypeOfSymbolAtLocation(slot, at);
}

function propertyKey(element: ts.BindingElement): string | undefined {
  const key = element.propertyName ?? element.name;
  return ts.isIdentifier(key) ||
    ts.isStringLiteral(key) ||
    ts.isNumericLiteral(key)
    ? key.text
    : undefined;
}

/**
 * The bindings of an untyped destructuring declaration that take `any` from
 * what `source` declares: a property or tuple slot typed `any`, or any element
 * of an `any[]`. An index signature, another iterable and a rest from an
 * object or a tuple are left alone, as `typescript/no-unsafe-assignment`
 * leaves them.
 */
function destructuredFindings(
  checker: ts.TypeChecker,
  pattern: ts.BindingPattern,
  source: ts.Type,
): Finding[] {
  if (ts.isObjectBindingPattern(pattern))
    return pattern.elements.flatMap((element) => {
      const key = propertyKey(element);
      const slot =
        element.dotDotDotToken === undefined && key !== undefined
          ? declaredSlot(checker, source, key, element)
          : undefined;
      return slot === undefined ? [] : elementFindings(checker, element, slot);
    });
  const anyArray = isAnyOrAnyArray(checker, source);
  if (!anyArray && !checker.isTupleType(source)) return [];
  return pattern.elements.flatMap((element, index) => {
    if (ts.isOmittedExpression(element)) return [];
    if (anyArray)
      return elementFindings(checker, element, checker.getAnyType());
    const slot =
      element.dotDotDotToken === undefined
        ? declaredSlot(checker, source, String(index), element)
        : undefined;
    return slot === undefined ? [] : elementFindings(checker, element, slot);
  });
}

function declarationFindings(
  checker: ts.TypeChecker,
  node: ts.VariableDeclaration,
  initializer: ts.Expression,
): Finding[] {
  if (
    leaks(
      checker,
      checker.getTypeAtLocation(initializer),
      node.type === undefined
        ? undefined
        : checker.getTypeAtLocation(node.name),
    )
  )
    return [{ kind: "assignment", node }];
  return node.type === undefined && !ts.isIdentifier(node.name)
    ? destructuredFindings(
        checker,
        node.name,
        checker.getTypeAtLocation(initializer),
      )
    : [];
}

function assignmentFindings(checker: ts.TypeChecker, node: ts.Node): Finding[] {
  if (ts.isVariableDeclaration(node) && node.initializer !== undefined)
    return declarationFindings(checker, node, node.initializer);
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken
  )
    return leaks(
      checker,
      checker.getTypeAtLocation(node.right),
      checker.getTypeAtLocation(node.left),
    )
      ? [{ kind: "assignment", node }]
      : [];
  if (
    (ts.isParameter(node) || ts.isBindingElement(node)) &&
    node.initializer !== undefined
  )
    return leaksIntoContext(checker, node.initializer)
      ? [{ kind: "assignment", node }]
      : [];
  if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))
    return propertyFindings(checker, node);
  return [];
}

function nodeFindings(checker: ts.TypeChecker, node: ts.Node): Finding[] {
  if (ts.isSpreadElement(node)) return spreadFindings(checker, node);
  if (ts.isCallExpression(node) || ts.isNewExpression(node))
    return argumentFindings(checker, node);
  if (ts.isReturnStatement(node) && node.expression !== undefined)
    return returned(checker, node.expression);
  if (ts.isArrowFunction(node) && !ts.isBlock(node.body))
    return returned(checker, node.body);
  return assignmentFindings(checker, node);
}

function findings({ checker, sourceFile }: TypedFile): Finding[] {
  const found: Finding[] = [];
  function visit(node: ts.Node): void {
    found.push(...nodeFindings(checker, node));
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

/**
 * `typescript/no-unsafe-assignment`, `no-unsafe-argument` and
 * `no-unsafe-return` for the script blocks of a `.vue` file, which
 * oxlint-tsgolint cannot read: an `any` or `any[]` reaching a declared type
 * through a declaration, an assignment, an object literal property, a
 * default value, an argument, a spread, a destructured binding or a return.
 * A destructuring assignment such as `({ a } = value)` is not checked.
 * TypeScript files stay with tsgolint, and a
 * component with `generic` type parameters is skipped, as only Vue's compiler
 * brings them into scope.
 */
export const noUnsafeAnyInVueRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "A Vue component's script assigns, passes and returns no `any` where a type is declared.",
    },
    messages: {
      assignment:
        "Unsafe assignment of an `any` value, which `typescript/no-unsafe-assignment` reports in a TypeScript file. Use a typed value or `unknown`, and narrow it before use.",
      argument:
        "Unsafe argument of type `any` to a typed parameter, which `typescript/no-unsafe-argument` reports in a TypeScript file. Pass a typed value.",
      return:
        "Unsafe return of an `any` value from a function with a declared return type, which `typescript/no-unsafe-return` reports in a TypeScript file. Return a typed value.",
    },
  },
  createOnce(context) {
    return {
      Program() {
        const { filename, sourceCode } = context;
        if (!filename.endsWith(".vue")) return;
        const { text } = sourceCode;
        const component =
          scriptView(text) === undefined
            ? readFileSync(filename, "utf8")
            : text;
        const offset = component.indexOf(text);
        if (offset === -1 || declaresTypeParameters(component)) return;
        const typed = typedFile(filename, component);
        if (typed === undefined) return;
        for (const { kind, node } of findings(typed)) {
          const start = node.getStart(typed.sourceFile) - offset;
          const end = node.end - offset;
          if (start >= 0 && end <= text.length)
            context.report({
              messageId: kind,
              loc: {
                start: sourceCode.getLocFromIndex(start),
                end: sourceCode.getLocFromIndex(end),
              },
            });
        }
      },
    };
  },
});
