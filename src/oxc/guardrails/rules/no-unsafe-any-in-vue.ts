import { defineRule } from "@oxlint/plugins";
import ts from "@typescript/typescript6";

import { typedFile, type TypedFile } from "../type-checker.ts";
import {
  arrayElement,
  isAnyOrAnyArray,
  isAnyType,
  isUnknown,
  leaks,
  returnLeaks,
} from "../any-leaks.ts";
import { lintedSource } from "../vue-script.ts";

/** Which `typescript/no-unsafe-*` rule a finding stands in for. */
type Unsafe = "assignment" | "argument" | "return";

interface Finding {
  kind: Unsafe;
  node: ts.Node;
}

function isAny(checker: ts.TypeChecker, node: ts.Node): boolean {
  return isAnyType(checker, checker.getTypeAtLocation(node));
}

/** Whether `sender` lets `any` into an assigned `receiver`: `any` into anything but `unknown`, a slot declared `any` included, or what {@link leaks} finds. */
function assignmentLeaks(
  checker: ts.TypeChecker,
  sender: ts.Type,
  receiver: ts.Type | undefined,
): boolean {
  return isAnyType(checker, sender)
    ? !isUnknown(receiver)
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

/** The call signatures of `type` as tsgolint lists them: each union member's in turn, and an intersection's only when one member alone is callable. */
function callSignatures(type: ts.Type): readonly ts.Signature[] {
  if (type.isUnion()) return type.types.flatMap(callSignatures);
  if (!type.isIntersection()) return type.getCallSignatures();
  const callable = type.types
    .map(callSignatures)
    .filter((signatures) => signatures.length > 0);
  return callable.length === 1 ? (callable[0] ?? []) : [];
}

/** The return type `owner`'s annotation declares, awaited when `owner` is async. */
function annotatedReturn(
  checker: ts.TypeChecker,
  owner: ts.SignatureDeclaration,
  annotation: ts.TypeNode,
): ts.Type | undefined {
  const declared = checker.getTypeFromTypeNode(annotation);
  const isAsync =
    ts.canHaveModifiers(owner) &&
    ts
      .getModifiers(owner)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
  return isAsync ? checker.getAwaitedType(declared) : declared;
}

/**
 * Whether `owner`, a function with no return annotation, leaks `sender` into
 * the returns its context declares, one per call signature, as in
 * `() => unknown` for a callback parameter: an `any` none of them declares
 * `unknown`, or an `any[]` none declares `unknown[]`, as
 * `typescript/no-unsafe-return` judges such a function by its own inferred
 * `any` return, not by a contextual `any`, or another array or tuple holding
 * `any` that {@link leaks} finds against the first of them.
 */
function unannotatedLeaks(
  checker: ts.TypeChecker,
  sender: ts.Type,
  owner: ts.SignatureDeclaration,
): boolean {
  const contextual = ts.isExpression(owner)
    ? checker.getContextualType(owner)
    : undefined;
  const receivers = contextual
    ? callSignatures(checker.getNonNullableType(contextual)).map((signature) =>
        signature.getReturnType(),
      )
    : [];
  if (isAnyType(checker, sender)) return !receivers.some(isUnknown);
  if (isAnyOrAnyArray(checker, sender))
    return !receivers.some((receiver) =>
      isUnknown(arrayElement(checker, receiver)),
    );
  return leaks(checker, sender, receivers[0]);
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
  let owner = value.parent;
  while (!ts.isFunctionLike(owner)) {
    if (ts.isSourceFile(owner)) return [];
    owner = owner.parent;
  }
  const sender = checker.getTypeAtLocation(value);
  const unsafe =
    owner.type === undefined
      ? unannotatedLeaks(checker, sender, owner)
      : returnLeaks(
          checker,
          sender,
          annotatedReturn(checker, owner, owner.type),
        );
  return unsafe ? [{ kind: "return", node: value }] : [];
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

/** The elements a pattern `name`, annotated or not, takes `any` into from `initializer`. */
function bindingFindings(
  checker: ts.TypeChecker,
  name: ts.BindingName,
  initializer: ts.Expression,
): Finding[] {
  const source = checker.getTypeAtLocation(initializer);
  return ts.isIdentifier(name)
    ? []
    : destructuredFindings(checker, name, source);
}

function declarationFindings(
  checker: ts.TypeChecker,
  node: ts.VariableDeclaration,
  initializer: ts.Expression,
): Finding[] {
  const source = checker.getTypeAtLocation(initializer);
  const declared = node.type && checker.getTypeAtLocation(node.name);
  return assignmentLeaks(checker, source, declared)
    ? [{ kind: "assignment", node }]
    : bindingFindings(checker, node.name, initializer);
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
  if (ts.isParameter(node) && node.initializer !== undefined)
    return leaksIntoContext(checker, node.initializer)
      ? [{ kind: "assignment", node }]
      : bindingFindings(checker, node.name, node.initializer);
  if (ts.isBindingElement(node) && node.initializer !== undefined)
    return assignmentLeaks(
      checker,
      checker.getTypeAtLocation(node.initializer),
      checker.getTypeAtLocation(node.name),
    )
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
        "Unsafe return of an `any` value, which `typescript/no-unsafe-return` reports in a TypeScript file. Return a typed value.",
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
