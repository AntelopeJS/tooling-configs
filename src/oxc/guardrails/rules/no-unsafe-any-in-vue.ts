import { defineRule } from "@oxlint/plugins";
import ts from "@typescript/typescript6";

import { typedFile, type TypedFile } from "../type-checker.ts";
import { isAnyOrAnyArray, isAnyType, isUnknown, leaks } from "../any-leaks.ts";
import { unsafeArguments } from "../any-arguments.ts";
import { returnLeaks } from "../any-returns.ts";
import { lintedSource } from "../vue-script.ts";

/** Which `typescript/no-unsafe-*` rule a finding stands in for. */
type Unsafe = "assignment" | "argument" | "return";

interface Finding {
  kind: Unsafe;
  node: ts.Node;
}

/** Whether `value` lets `any` into an assigned `receiver`: `any` into anything but `unknown`, a slot declared `any` included, or what {@link leaks} finds. */
function assignmentLeaks(
  checker: ts.TypeChecker,
  value: ts.Expression,
  receiver: ts.Type | undefined,
): boolean {
  const sender = checker.getTypeAtLocation(value);
  return isAnyType(checker, sender)
    ? !isUnknown(receiver)
    : leaks(checker, sender, receiver, value);
}

/** Whether `value`, flowing into the slot its context declares, lets `any` in. */
function leaksIntoContext(
  checker: ts.TypeChecker,
  value: ts.Expression,
): boolean {
  return assignmentLeaks(checker, value, checker.getContextualType(value));
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

function returned(checker: ts.TypeChecker, value: ts.Expression): Finding[] {
  return returnLeaks(checker, value) ? [{ kind: "return", node: value }] : [];
}

/** An `any` or `any[]` spread into an array literal that is not a destructuring target. A spread into a call is an argument, which {@link unsafeArguments} judges. */
function spreadFindings(
  checker: ts.TypeChecker,
  spread: ts.SpreadElement,
): Finding[] {
  return ts.isArrayLiteralExpression(spread.parent) &&
    !isDestructuringTarget(spread.parent) &&
    isAnyOrAnyArray(checker, checker.getTypeAtLocation(spread.expression))
    ? [{ kind: "assignment", node: spread }]
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
        fallback,
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

/** An element that takes an `any` its source declares, and the elements nested under one with no default, as a nested pattern with a default reads that default. */
function elementFindings(
  checker: ts.TypeChecker,
  element: PatternElement,
  source: ts.Type,
): Finding[] {
  if (isAnyType(checker, source))
    return [{ kind: "assignment", node: element.node }];
  return element.initializer === undefined && isPattern(element.target)
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
  const declared = node.type && checker.getTypeAtLocation(node.name);
  return assignmentLeaks(checker, initializer, declared)
    ? [{ kind: "assignment", node }]
    : bindingFindings(checker, node.name, initializer);
}

/** A JSX attribute whose value lets `any` into the prop it fills. */
function attributeFindings(
  checker: ts.TypeChecker,
  attribute: ts.JsxAttribute,
): Finding[] {
  const value =
    attribute.initializer !== undefined &&
    ts.isJsxExpression(attribute.initializer)
      ? attribute.initializer.expression
      : undefined;
  return value !== undefined && leaksIntoContext(checker, value)
    ? [{ kind: "assignment", node: value }]
    : [];
}

/** A class field whose initializer lets `any` in: against its annotation, or whatever its type when it has none. */
function fieldFindings(
  checker: ts.TypeChecker,
  field: ts.PropertyDeclaration,
): Finding[] {
  return field.initializer !== undefined &&
    assignmentLeaks(
      checker,
      field.initializer,
      field.type && checker.getTypeAtLocation(field.name),
    )
    ? [{ kind: "assignment", node: field }]
    : [];
}

function assignmentFindings(checker: ts.TypeChecker, node: ts.Node): Finding[] {
  if (ts.isVariableDeclaration(node) && node.initializer !== undefined)
    return declarationFindings(checker, node, node.initializer);
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    if (
      assignmentLeaks(checker, node.right, checker.getTypeAtLocation(node.left))
    )
      return [{ kind: "assignment", node }];
    return ts.isObjectLiteralExpression(node.left) ||
      ts.isArrayLiteralExpression(node.left)
      ? destructuredFindings(
          checker,
          node.left,
          checker.getTypeAtLocation(node.right),
        )
      : [];
  }
  if (ts.isParameter(node) && node.initializer !== undefined)
    return leaksIntoContext(checker, node.initializer)
      ? [{ kind: "assignment", node }]
      : bindingFindings(checker, node.name, node.initializer);
  if (ts.isBindingElement(node) && node.initializer !== undefined)
    return assignmentLeaks(
      checker,
      node.initializer,
      checker.getTypeAtLocation(node.name),
    )
      ? [{ kind: "assignment", node }]
      : bindingFindings(checker, node.name, node.initializer);
  if (ts.isJsxAttribute(node)) return attributeFindings(checker, node);
  if (ts.isPropertyDeclaration(node)) return fieldFindings(checker, node);
  if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))
    return propertyFindings(checker, node);
  return [];
}

function nodeFindings(checker: ts.TypeChecker, node: ts.Node): Finding[] {
  if (ts.isSpreadElement(node)) return spreadFindings(checker, node);
  if (
    ts.isCallExpression(node) ||
    ts.isNewExpression(node) ||
    ts.isTaggedTemplateExpression(node)
  )
    return unsafeArguments(checker, node).map((argument) => ({
      kind: "argument",
      node: argument,
    }));
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
 * oxlint-tsgolint cannot read: an `any`, or a generic such as `any[]` or
 * `Set<any>` holding one, reaching a declared type
 * through a declaration, an assignment, an object literal property, a class
 * field, a JSX attribute in a `lang="tsx"` script, a default value, an
 * argument, a tagged template substitution, a spread, a tuple spread into
 * parameters, a destructured binding,
 * a destructuring assignment such as `({ a } = value)` or a return. An `any`
 * assigned to a slot declared `any` is reported too, as tsgolint reports it.
 * TypeScript files stay with tsgolint, and a
 * component with `generic` type parameters is skipped, as only Vue's compiler
 * brings them into scope.
 *
 * A tuple or generic returned into a union of callables is compared with the
 * member tsgo, which tsgolint runs, orders first. Two ties stay in TypeScript
 * 6's creation order, so the rule can compare another member than tsgolint
 * does: two instantiations of one anonymous generic, as in
 * `H<string>["m"] | H<unknown>["m"]`, which tsgo orders by their type
 * mappers, and two same-named types declared in different files, which tsgo
 * orders by its program's file order. TypeScript 6 exposes neither.
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
