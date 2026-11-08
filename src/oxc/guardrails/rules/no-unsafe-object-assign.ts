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

/** The type a source property writes: the literal type of an initializer in the source itself, as a direct assignment would read it. */
function writtenType(
  checker: ts.TypeChecker,
  property: ts.Symbol,
  source: ts.Expression,
): ts.Type {
  const declaration = property.valueDeclaration;
  return declaration !== undefined &&
    ts.isPropertyAssignment(declaration) &&
    declaration.getSourceFile() === source.getSourceFile() &&
    declaration.pos >= source.pos &&
    declaration.end <= source.end
    ? checker.getTypeAtLocation(declaration.initializer)
    : checker.getTypeOfSymbolAtLocation(property, source);
}

/** The types a field accepts: its read type, and the parameter type of its setter when it has one. */
function acceptedTypes(
  checker: ts.TypeChecker,
  field: ts.Symbol,
  source: ts.Expression,
): ts.Type[] {
  const setter = field.declarations?.find(ts.isSetAccessorDeclaration);
  const parameter = setter?.parameters[0];
  const read = checker.getTypeOfSymbolAtLocation(field, source);
  return parameter === undefined
    ? [read]
    : [read, checker.getTypeAtLocation(parameter)];
}

function fieldWrite(
  checker: ts.TypeChecker,
  property: ts.Symbol,
  field: ts.Symbol,
  source: ts.Expression,
): Write | undefined {
  const value = writtenType(checker, property, source);
  const accepted = acceptedTypes(checker, field, source);
  if (accepted.some((type) => type.flags & UNTYPED)) return undefined;
  if (
    value.flags & UNTYPED ||
    (holdsAny(checker, value) &&
      !accepted.some((type) => holdsAny(checker, type)))
  )
    return { kind: "untypedField", name: property.name };
  const written =
    property.flags & ts.SymbolFlags.Optional
      ? members(value).filter(
          (member) => !(member.flags & ts.TypeFlags.Undefined),
        )
      : [value];
  return written.every((member) =>
    accepted.some((type) => checker.isTypeAssignableTo(member, type)),
  )
    ? undefined
    : { kind: "mistypedField", name: property.name };
}

function sourceWrites(
  checker: ts.TypeChecker,
  target: ts.Type,
  source: ts.Expression,
): Write[] {
  const writes = new Map<string, Write>();
  for (const member of members(checker.getTypeAtLocation(source))) {
    if (
      member.flags & UNTYPED ||
      checker
        .getIndexInfosOfType(member)
        .some((info) => info.type.flags & UNTYPED)
    )
      writes.set("", { kind: "untypedSource" });
    for (const property of checker.getPropertiesOfType(member)) {
      const field = checker.getPropertyOfType(target, property.name);
      const write = field && fieldWrite(checker, property, field, source);
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
        call.arguments.slice(1).forEach((source, index) => {
          if (ts.isSpreadElement(source)) return;
          for (const write of sourceWrites(typed.checker, target, source))
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
