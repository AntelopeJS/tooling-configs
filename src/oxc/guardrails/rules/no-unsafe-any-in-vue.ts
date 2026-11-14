import { defineRule } from "@oxlint/plugins";
import ts from "@typescript/typescript6";

import { typedFile, type TypedFile } from "../type-checker.ts";
import { lintedSource } from "../vue-script.ts";

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

function isObjectType(type: ts.Type): type is ts.ObjectType {
  return (type.flags & ts.TypeFlags.Object) !== 0;
}

function isReference(type: ts.ObjectType): type is ts.TypeReference {
  return (type.objectFlags & ts.ObjectFlags.Reference) !== 0;
}

/** The array or tuple reference `type` is, for comparing by its generic target as tsgolint does. */
function arrayReference(
  checker: ts.TypeChecker,
  type: ts.Type,
): ts.TypeReference | undefined {
  return (checker.isArrayType(type) || checker.isTupleType(type)) &&
    isObjectType(type) &&
    isReference(type)
    ? type
    : undefined;
}

/**
 * Whether a `sender` value lets `any` into a `receiver` slot as an argument,
 * a return or a type argument: `any` into a slot that is undeclared or typed
 * neither `any` nor `unknown`, or an array or tuple holding `any`, as in
 * `any[]`, into one of the same generic target, such as `string[]`, with
 * another type in that position. `readonly` and labelled tuples have targets
 * of their own.
 */
function leaks(
  checker: ts.TypeChecker,
  sender: ts.Type,
  receiver: ts.Type | undefined,
  depth = 0,
): boolean {
  if (isAnyType(checker, sender))
    return receiver === undefined || !takesAnything(receiver);
  if (receiver === undefined || depth === MAX_DEPTH) return false;
  const from = arrayReference(checker, sender);
  const to = arrayReference(checker, receiver);
  if (from === undefined || to === undefined || from.target !== to.target)
    return false;
  const slots = checker.getTypeArguments(to);
  return checker
    .getTypeArguments(from)
    .some((argument, index) =>
      leaks(checker, argument, slots[index], depth + 1),
    );
}

/** Whether `sender` lets `any` into an assigned `receiver`: `any` into anything but `unknown`, a slot declared `any` included, or what {@link leaks} finds. */
function assignmentLeaks(
  checker: ts.TypeChecker,
  sender: ts.Type,
  receiver: ts.Type | undefined,
): boolean {
  return isAnyType(checker, sender)
    ? receiver === undefined || (receiver.flags & ts.TypeFlags.Unknown) === 0
    : leaks(checker, sender, receiver);
}

/** Whether `value`, flowing into the slot its context declares, lets `any` in. */
function leaksIntoContext(
  checker: ts.TypeChecker,
  value: ts.Expression,
): boolean {
  return assignmentLeaks(
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
    ? checker.getIndexTypeOfType(type, ts.IndexKind.Number)
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
  if (isDestructuringTarget(property.parent)) {
    const fallback = ts.isShorthandPropertyAssignment(property)
      ? property.objectAssignmentInitializer
      : undefined;
    return fallback !== undefined &&
      assignmentLeaks(
        checker,
        checker.getTypeAtLocation(fallback),
        checker.getTypeAtLocation(property.name),
      )
      ? [{ kind: "assignment", node: property }]
      : [];
  }
  const value = ts.isPropertyAssignment(property)
    ? property.initializer
    : property.name;
  return leaksIntoContext(checker, value)
    ? [{ kind: "assignment", node: property }]
    : [];
}

/** A destructuring pattern, as a declaration binds it or an assignment such as `({ a } = value)` writes it. */
type Pattern =
  | ts.BindingPattern
  | ts.ObjectLiteralExpression
  | ts.ArrayLiteralExpression;

/** One element of a {@link Pattern}. */
interface PatternElement {
  /** The source property or tuple index it reads, `undefined` for a rest or a computed name. */
  key: string | undefined;
  /** The name or target it writes, a nested pattern when it destructures further. */
  target: ts.Node;
  initializer: ts.Expression | undefined;
  /** Where a finding on it is reported. */
  node: ts.Node;
}

function isPattern(node: ts.Node): node is Pattern {
  return (
    ts.isObjectBindingPattern(node) ||
    ts.isArrayBindingPattern(node) ||
    ts.isObjectLiteralExpression(node) ||
    ts.isArrayLiteralExpression(node)
  );
}

/** The key a property name spells, a computed literal such as `['a']` included. */
function literalKey(
  name: ts.PropertyName | ts.BindingName,
): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  const key = ts.isComputedPropertyName(name) ? name.expression : name;
  return ts.isStringLiteral(key) ||
    ts.isNumericLiteral(key) ||
    ts.isNoSubstitutionTemplateLiteral(key)
    ? key.text
    : undefined;
}

/** The target and default of an assignment pattern element, as in `a = fallback`. */
function withDefault(
  element: ts.Expression,
): Pick<PatternElement, "target" | "initializer"> {
  return ts.isBinaryExpression(element) &&
    element.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ? { target: element.left, initializer: element.right }
    : { target: element, initializer: undefined };
}

function objectElements(
  pattern: ts.ObjectBindingPattern | ts.ObjectLiteralExpression,
): PatternElement[] {
  if (ts.isObjectBindingPattern(pattern))
    return pattern.elements.map((element) => ({
      key:
        element.dotDotDotToken === undefined
          ? literalKey(element.propertyName ?? element.name)
          : undefined,
      target: element.name,
      initializer: element.initializer,
      node: element,
    }));
  return pattern.properties.map((property) => {
    if (ts.isPropertyAssignment(property))
      return {
        key: literalKey(property.name),
        ...withDefault(property.initializer),
        node: property,
      };
    if (ts.isShorthandPropertyAssignment(property))
      return {
        key: property.name.text,
        target: property.name,
        initializer: property.objectAssignmentInitializer,
        node: property,
      };
    return {
      key: undefined,
      target: property,
      initializer: undefined,
      node: property,
    };
  });
}

function arrayElements(
  pattern: ts.ArrayBindingPattern | ts.ArrayLiteralExpression,
): PatternElement[] {
  const elements: readonly (ts.ArrayBindingElement | ts.Expression)[] =
    pattern.elements;
  return elements.flatMap((element, index): PatternElement[] => {
    if (ts.isOmittedExpression(element)) return [];
    if (ts.isBindingElement(element))
      return [
        {
          key: element.dotDotDotToken === undefined ? String(index) : undefined,
          target: element.name,
          initializer: element.initializer,
          node: element,
        },
      ];
    if (ts.isSpreadElement(element))
      return [
        {
          key: undefined,
          target: element.expression,
          initializer: undefined,
          node: element,
        },
      ];
    return [{ key: String(index), ...withDefault(element), node: element }];
  });
}

/** An element that takes an `any` its source declares, but for one whose default is itself reported, and the elements nested under it. */
function elementFindings(
  checker: ts.TypeChecker,
  element: PatternElement,
  source: ts.Type,
): Finding[] {
  if (isAnyType(checker, source))
    return element.initializer !== undefined &&
      isAny(checker, element.initializer)
      ? []
      : [{ kind: "assignment", node: element.node }];
  return isPattern(element.target)
    ? destructuredFindings(checker, element.target, source)
    : [];
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

function slotFindings(
  checker: ts.TypeChecker,
  element: PatternElement,
  source: ts.Type,
): Finding[] {
  const slot =
    element.key === undefined
      ? undefined
      : declaredSlot(checker, source, element.key, element.node);
  return slot === undefined ? [] : elementFindings(checker, element, slot);
}

/**
 * The elements of an untyped destructuring declaration or of a destructuring
 * assignment that take `any` from what `source` declares: a property or
 * tuple slot typed `any`, whatever the target's own type, or the whole
 * pattern once when it reads an `any[]`. An index signature, another iterable
 * and a rest from an object or a tuple are left alone, as
 * `typescript/no-unsafe-assignment` leaves them.
 */
function destructuredFindings(
  checker: ts.TypeChecker,
  pattern: Pattern,
  source: ts.Type,
): Finding[] {
  if (
    ts.isObjectBindingPattern(pattern) ||
    ts.isObjectLiteralExpression(pattern)
  )
    return objectElements(pattern).flatMap((element) =>
      slotFindings(checker, element, source),
    );
  if (isAnyOrAnyArray(checker, source))
    return [{ kind: "assignment", node: pattern }];
  return checker.isTupleType(source)
    ? arrayElements(pattern).flatMap((element) =>
        slotFindings(checker, element, source),
      )
    : [];
}

function declarationFindings(
  checker: ts.TypeChecker,
  node: ts.VariableDeclaration,
  initializer: ts.Expression,
): Finding[] {
  if (
    assignmentLeaks(
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
  ) {
    const source = checker.getTypeAtLocation(node.right);
    if (assignmentLeaks(checker, source, checker.getTypeAtLocation(node.left)))
      return [{ kind: "assignment", node }];
    return ts.isObjectLiteralExpression(node.left) ||
      ts.isArrayLiteralExpression(node.left)
      ? destructuredFindings(checker, node.left, source)
      : [];
  }
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
 * default value, an argument, a spread, a destructured binding, a
 * destructuring assignment such as `({ a } = value)` or a return. An `any`
 * assigned to a slot declared `any` is reported too, as tsgolint reports it.
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
        const linted = lintedSource(filename, text);
        if (linted === undefined) return;
        const { offset } = linted;
        const typed = typedFile(filename, linted.text);
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
