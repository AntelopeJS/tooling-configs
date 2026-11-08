import { defineRule } from "@oxlint/plugins";
import ts from "typescript";

import { callName } from "../shared.ts";
import { nodeAt, typedFile } from "../type-checker.ts";

const UNTYPED = ts.TypeFlags.Any | ts.TypeFlags.Unknown;

/** What one `Object.assign` source writes over a field the target declares. */
type Write =
  | { kind: "untypedSource" }
  | { kind: "untypedField" | "mistypedField"; name: string };

function sourceWrites(
  checker: ts.TypeChecker,
  target: ts.Type,
  source: ts.Expression,
): Write[] {
  const type = checker.getTypeAtLocation(source);
  if (type.flags & UNTYPED) return [{ kind: "untypedSource" }];
  const writes: Write[] = [];
  for (const property of checker.getPropertiesOfType(type)) {
    const field = checker.getPropertyOfType(target, property.name);
    if (field === undefined) continue;
    const written = checker.getTypeOfSymbolAtLocation(property, source);
    const value =
      property.flags & ts.SymbolFlags.Optional
        ? checker.getNonNullableType(written)
        : written;
    if (value.flags & UNTYPED)
      writes.push({ kind: "untypedField", name: property.name });
    else if (
      !checker.isTypeAssignableTo(
        value,
        checker.getTypeOfSymbolAtLocation(field, source),
      )
    )
      writes.push({ kind: "mistypedField", name: property.name });
  }
  return writes;
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
        "This Object.assign source is typed `unknown` or `any`, and it overwrites fields the target declares without a check: `Object.assign<T, U>` returns `T & U`. Parse it into a typed value first.",
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
        const target = typed.checker.getTypeAtLocation(call.arguments[0]);
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
