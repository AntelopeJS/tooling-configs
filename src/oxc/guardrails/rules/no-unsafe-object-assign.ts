import { defineRule } from "@oxlint/plugins";
import ts from "typescript";

import { callName } from "../shared.ts";
import { nodeAt, typedFile } from "../type-checker.ts";

const UNTYPED = ts.TypeFlags.Any | ts.TypeFlags.Unknown;
const MAX_DEPTH = 4;

/** What one `Object.assign` source writes over a field the target declares. */
type Write =
  | { kind: "untypedSource" }
  | { kind: "untypedField" | "mistypedField"; name: string };

function members(type: ts.Type): readonly ts.Type[] {
  return type.isUnion() ? type.types : [type];
}

/** Whether `type` is `any`, or holds `any` in a union, an intersection or the elements of an array or tuple, as in `any[]`. */
function holdsAny(checker: ts.TypeChecker, type: ts.Type, depth = 0): boolean {
  if (type.flags & ts.TypeFlags.Any) return true;
  if (depth === MAX_DEPTH) return false;
  const element =
    checker.isArrayType(type) || checker.isTupleType(type)
      ? checker.getIndexTypeOfType(type, ts.IndexKind.Number)
      : undefined;
  const inner = type.isUnionOrIntersection()
    ? type.types
    : element === undefined
      ? []
      : [element];
  return inner.some((member) => holdsAny(checker, member, depth + 1));
}

/** The checker and the compiler option that decides whether an optional property may hold `undefined`. */
interface Check {
  checker: ts.TypeChecker;
  exactOptional: boolean;
}

/** The types a field accepts: its read type, and its setter's parameter type. Undefined when a setter of a generic class or interface takes a type this rule cannot instantiate. */
function acceptedTypes(
  checker: ts.TypeChecker,
  field: ts.Symbol,
  source: ts.Expression,
): ts.Type[] | undefined {
  const setter = field.declarations?.find(ts.isSetAccessorDeclaration);
  const parameter = setter?.parameters[0];
  const read = checker.getTypeOfSymbolAtLocation(field, source);
  if (parameter === undefined) return [read];
  const owner = setter?.parent;
  return owner !== undefined &&
    (ts.isClassLike(owner) || ts.isInterfaceDeclaration(owner)) &&
    owner.typeParameters !== undefined
    ? undefined
    : [read, checker.getTypeAtLocation(parameter)];
}

function untyped(type: ts.Type): boolean {
  return (type.flags & UNTYPED) !== 0;
}

/** How a write fails: an `unknown` or `any` value, or a value no accepted type takes. */
type Verdict = "untypedField" | "mistypedField" | undefined;

function typeVerdict(
  { checker, exactOptional }: Check,
  type: ts.Type,
  accepted: readonly ts.Type[],
  optional: boolean,
): Verdict {
  if (accepted.length === 0 || accepted.some(untyped)) return undefined;
  if (
    untyped(type) ||
    (holdsAny(checker, type) &&
      !accepted.some((member) => holdsAny(checker, member)))
  )
    return "untypedField";
  const written =
    optional && !exactOptional
      ? members(type).filter(
          (member) => !(member.flags & ts.TypeFlags.Undefined),
        )
      : [type];
  return written.every((member) =>
    accepted.some((field) => checker.isTypeAssignableTo(member, field)),
  )
    ? undefined
    : "mistypedField";
}

/** The types the fields in `accepted` give their property `name`. */
function propertyTypes(
  checker: ts.TypeChecker,
  accepted: readonly ts.Type[],
  name: string,
  at: ts.Node,
): ts.Type[] {
  return accepted.flatMap((type) => {
    const field = checker.getPropertyOfType(
      checker.getNonNullableType(type),
      name,
    );
    return field === undefined
      ? []
      : [checker.getTypeOfSymbolAtLocation(field, at)];
  });
}

/** The element types of the array or tuple fields in `accepted`. */
function elementTypes(
  checker: ts.TypeChecker,
  accepted: readonly ts.Type[],
): ts.Type[] {
  return accepted.flatMap((type) => {
    const element = checker.getIndexTypeOfType(
      checker.getNonNullableType(type),
      ts.IndexKind.Number,
    );
    return element === undefined ? [] : [element];
  });
}

/** The type a written value has: a shorthand property reads its variable, as a direct assignment would. */
function valueType(checker: ts.TypeChecker, value: ts.Expression): ts.Type {
  const shorthand =
    ts.isShorthandPropertyAssignment(value.parent) &&
    value.parent.name === value
      ? checker.getShorthandAssignmentValueSymbol(value.parent)
      : undefined;
  return shorthand === undefined
    ? checker.getTypeAtLocation(value)
    : checker.getTypeOfSymbolAtLocation(shorthand, value);
}

/** The parts of an object or array literal, each with the types the field gives it; undefined when a spread, computed key or accessor leaves only the literal's own type to compare. */
function literalParts(
  checker: ts.TypeChecker,
  literal: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  accepted: readonly ts.Type[],
): { value: ts.Expression; accepted: ts.Type[] }[] | undefined {
  if (ts.isArrayLiteralExpression(literal)) {
    const elements = elementTypes(checker, accepted);
    return elements.length === 0 || literal.elements.some(ts.isSpreadElement)
      ? undefined
      : literal.elements.map((value) => ({ value, accepted: elements }));
  }
  const parts = [];
  for (const property of literal.properties) {
    if (
      !(
        ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property)
      ) ||
      !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    )
      return undefined;
    parts.push({
      value: ts.isPropertyAssignment(property)
        ? property.initializer
        : property.name,
      accepted: propertyTypes(checker, accepted, property.name.text, literal),
    });
  }
  return parts;
}

/** Compares a value written in the source with the field, part by part through nested literals, so a literal keeps the type a direct assignment gives it. */
function expressionVerdict(
  check: Check,
  expression: ts.Expression,
  accepted: readonly ts.Type[],
  depth = 0,
): Verdict {
  let value = expression;
  while (ts.isParenthesizedExpression(value)) value = value.expression;
  const parts =
    depth < MAX_DEPTH &&
    (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value))
      ? literalParts(check.checker, value, accepted)
      : undefined;
  if (parts === undefined)
    return typeVerdict(check, valueType(check.checker, value), accepted, false);
  for (const part of parts) {
    const verdict = expressionVerdict(
      check,
      part.value,
      part.accepted,
      depth + 1,
    );
    if (verdict !== undefined) return verdict;
  }
  return undefined;
}

function fieldWrite(
  check: Check,
  property: ts.Symbol,
  field: ts.Symbol,
  source: ts.Expression,
): Write | undefined {
  const accepted = acceptedTypes(check.checker, field, source);
  if (accepted === undefined) return undefined;
  const declaration = property.valueDeclaration;
  const inSource =
    declaration !== undefined &&
    declaration.getSourceFile() === source.getSourceFile() &&
    declaration.pos >= source.pos &&
    declaration.end <= source.end;
  const kind =
    inSource && ts.isPropertyAssignment(declaration)
      ? expressionVerdict(check, declaration.initializer, accepted)
      : inSource && ts.isShorthandPropertyAssignment(declaration)
        ? expressionVerdict(check, declaration.name, accepted)
        : typeVerdict(
            check,
            check.checker.getTypeOfSymbolAtLocation(property, source),
            accepted,
            (property.flags & ts.SymbolFlags.Optional) !== 0,
          );
  return kind === undefined ? undefined : { kind, name: property.name };
}

/** Whether a source member can write keys: an object, not a primitive such as the `false` of `flag && { ... }`. */
const WRITES_KEYS =
  ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive | ts.TypeFlags.Intersection;

/** Whether the target declares a field that does not take `unknown`, which an untyped string-keyed source could overwrite. */
function hasTypedField(checker: ts.TypeChecker, target: ts.Type): boolean {
  return checker
    .getPropertiesOfType(target)
    .some((field) => !untyped(checker.getTypeOfSymbol(field)));
}

function untypedKeys(checker: ts.TypeChecker, member: ts.Type): boolean {
  return checker
    .getIndexInfosOfType(member)
    .some(
      (info) =>
        (info.keyType.flags & ts.TypeFlags.String) !== 0 && untyped(info.type),
    );
}

function sourceWrites(
  check: Check,
  target: ts.Type,
  source: ts.Expression,
): Write[] {
  const { checker } = check;
  const writes = new Map<string, Write>();
  for (const member of members(checker.getTypeAtLocation(source))) {
    if (
      untyped(member) ||
      (untypedKeys(checker, member) && hasTypedField(checker, target))
    )
      writes.set("", { kind: "untypedSource" });
    if (!(member.flags & WRITES_KEYS)) continue;
    for (const property of checker.getPropertiesOfType(member)) {
      const field = checker.getPropertyOfType(target, property.name);
      const write = field && fieldWrite(check, property, field, source);
      if (write !== undefined) writes.set(property.name, write);
    }
  }
  return [...writes.values()];
}

/** `Object.assign<T, U>` returns `T & U` without comparing `U` with `T`, so a source can write `unknown`, `any` or a wrong type over a field `T` declares. */
export const noUnsafeObjectAssignRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Object.assign writes no unknown, any or unassignable value over a field its target declares.",
    },
    messages: {
      untypedSource:
        "This Object.assign source is typed `unknown` or `any`, or holds such values under an index signature, and it overwrites fields the target declares without a check: `Object.assign<T, U>` returns `T & U`. Parse it into a typed value first.",
      untypedField:
        "Object.assign writes an `unknown` or `any` value over `{{name}}`, a field the target declares, and TypeScript never compares the two: `Object.assign<T, U>` returns `T & U`. Parse the value into the field's type first.",
      mistypedField:
        "Object.assign writes a value over `{{name}}` that the target's `{{name}}` type does not accept, and TypeScript never compares the two: `Object.assign<T, U>` returns `T & U`. Assign the field directly so the compiler checks it.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (
          callName(node.callee) !== "Object.assign" ||
          node.arguments.length < 2
        )
          return;
        const typed = typedFile(context.filename, context.sourceCode.text);
        const call =
          typed && nodeAt(typed.sourceFile, node, ts.isCallExpression);
        if (typed === undefined || call === undefined) return;
        const declared = typed.checker.getTypeAtLocation(call.arguments[0]);
        const target = declared.isTypeParameter()
          ? (typed.checker.getBaseConstraintOfType(declared) ?? declared)
          : declared;
        if (typed.checker.getPropertiesOfType(target).length === 0) return;
        const check = {
          checker: typed.checker,
          exactOptional: typed.options.exactOptionalPropertyTypes === true,
        };
        call.arguments.slice(1).forEach((source, index) => {
          if (ts.isSpreadElement(source)) return;
          for (const write of sourceWrites(check, target, source))
            context.report({
              node: node.arguments[index + 1],
              messageId: write.kind,
              data: "name" in write ? { name: write.name } : {},
            });
        });
      },
    };
  },
});
