import { defineRule } from "@oxlint/plugins";
import ts from "@typescript/typescript6";

import { callName } from "../shared.ts";
import { literalFits, valueType } from "../literal-fit.ts";
import { nodeAt, typedFile } from "../type-checker.ts";
import { lintedSource } from "../vue-script.ts";

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

/** Whether a declaration sits inside a generic class, interface or type alias, whose type parameters the public checker API cannot instantiate for a declaration. */
function insideGeneric(declaration: ts.Node): boolean {
  for (
    let node = declaration.parent;
    !ts.isSourceFile(node);
    node = node.parent
  )
    if (
      (ts.isClassLike(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node)) &&
      node.typeParameters !== undefined
    )
      return true;
  return false;
}

/** The types a field accepts: its read type, and its setter's parameter type. Undefined when the setter sits inside a generic declaration, whose parameter type this rule cannot instantiate. */
function acceptedTypes(
  checker: ts.TypeChecker,
  field: ts.Symbol,
  source: ts.Expression,
): ts.Type[] | undefined {
  const setter = field.declarations?.find(ts.isSetAccessorDeclaration);
  const parameter = setter?.parameters[0];
  const read = checker.getTypeOfSymbolAtLocation(field, source);
  if (setter === undefined || parameter === undefined) return [read];
  return insideGeneric(setter)
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

function fieldWrite(
  check: Check,
  property: ts.Symbol,
  field: ts.Symbol,
  source: ts.Expression,
): Write | undefined {
  const { checker } = check;
  const accepted = acceptedTypes(checker, field, source);
  if (accepted === undefined) return undefined;
  const declaration = property.valueDeclaration;
  const written =
    declaration !== undefined &&
    declaration.getSourceFile() === source.getSourceFile() &&
    declaration.pos >= source.pos &&
    declaration.end <= source.end &&
    (ts.isPropertyAssignment(declaration) ||
      ts.isShorthandPropertyAssignment(declaration))
      ? ts.isPropertyAssignment(declaration)
        ? declaration.initializer
        : declaration.name
      : undefined;
  const kind =
    written === undefined
      ? typeVerdict(
          check,
          checker.getTypeOfSymbolAtLocation(property, source),
          accepted,
          (property.flags & ts.SymbolFlags.Optional) !== 0,
        )
      : typeVerdict(check, valueType(checker, written), accepted, false);
  if (
    kind === undefined ||
    (kind === "mistypedField" &&
      written !== undefined &&
      accepted.some((type) => literalFits(checker, written, type)))
  )
    return undefined;
  return { kind, name: property.name };
}

/** A primitive source member, such as the `false` of `flag && { ... }`, whose apparent members (`valueOf`) `Object.assign` never copies. */
const PRIMITIVE =
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.StringLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.Null |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Void |
  ts.TypeFlags.Never;

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
    if (member.flags & PRIMITIVE) continue;
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
        const linted = lintedSource(context.filename, context.sourceCode.text);
        const typed = linted && typedFile(context.filename, linted.text);
        const [start, end] = node.range;
        const call =
          linted &&
          typed &&
          nodeAt(
            typed.sourceFile,
            { range: [start + linted.offset, end + linted.offset] },
            ts.isCallExpression,
          );
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
