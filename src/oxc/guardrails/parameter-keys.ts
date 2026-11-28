import type { ESTree, SourceCode } from "@oxlint/plugins";
import ts from "../../typescript6.ts";

import { resolveVariable, unwrapExpression } from "./local-types.ts";
import { nodeAt, typedFile } from "./type-checker.ts";
import { lintedSource } from "./vue-script.ts";

/** The key types that name no key outside the ones they list: string literals, and the primitives that never convert to the name of an `Object.prototype` property. */
const CLOSED_KEY =
  ts.TypeFlags.StringLiteral |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Null |
  ts.TypeFlags.Never;

/** Whether the parameter `key` reads is declared with a union member outside {@link CLOSED_KEY}, each type parameter standing for its base constraint and one with no constraint for any value. A narrowing at the read is not trusted: a type predicate such as `k is keyof typeof T` built on `k in T` also holds for `constructor`. */
function isOpenKeyType(checker: ts.TypeChecker, key: ts.Identifier): boolean {
  const parameter = checker.getSymbolAtLocation(key);
  if (parameter === undefined) return true;
  const declared = checker.getTypeOfSymbol(parameter);
  const type = checker.getBaseConstraintOfType(declared) ?? declared;
  const members = type.isUnion() ? type.types : [type];
  return members.some((member) => (member.flags & CLOSED_KEY) === 0);
}

/**
 * A key read from an annotated parameter whose declared type, as the program
 * of the file's tsconfig checks it, can hold a string outside a closed set of
 * literals. False in a file no tsconfig lists.
 */
export function isOpenStringParameter(
  key: ESTree.Node,
  source: SourceCode,
  filename: string,
): boolean {
  if (key.type !== "Identifier") return false;
  const [definition] = resolveVariable(source, key)?.defs ?? [];
  if (
    definition?.type !== "Parameter" ||
    definition.name.type !== "Identifier" ||
    definition.name.typeAnnotation == null
  )
    return false;
  const linted = lintedSource(filename, source.text);
  const typed = linted && typedFile(filename, linted.text);
  if (linted === undefined || typed === undefined) return false;
  const [start, end] = key.range;
  const node = nodeAt(
    typed.sourceFile,
    { range: [start + linted.offset, end + linted.offset] },
    ts.isIdentifier,
  );
  return node !== undefined && isOpenKeyType(typed.checker, node);
}

function hasNullPrototype(object: ESTree.ObjectExpression): boolean {
  return object.properties.some(
    (property) =>
      property.type === "Property" &&
      !property.computed &&
      ((property.key.type === "Identifier" &&
        property.key.name === "__proto__") ||
        (property.key.type === "Literal" &&
          property.key.value === "__proto__")),
  );
}

/** A module-level `const` initialised with an object literal, behind `as const`, `satisfies` or a type assertion. */
export function isModuleLiteralTable(
  node: ESTree.Expression,
  source: SourceCode,
): boolean {
  if (node.type !== "Identifier") return false;
  const [definition] = resolveVariable(source, node)?.defs ?? [];
  if (
    definition?.type !== "Variable" ||
    definition.node.type !== "VariableDeclarator" ||
    definition.parent?.type !== "VariableDeclaration" ||
    definition.parent.kind !== "const" ||
    definition.node.init === null
  )
    return false;
  const owner = definition.parent.parent;
  if (
    owner.type !== "Program" &&
    !(
      owner.type === "ExportNamedDeclaration" && owner.parent.type === "Program"
    )
  )
    return false;
  let init = definition.node.init;
  while (
    init.type === "TSAsExpression" ||
    init.type === "TSSatisfiesExpression"
  )
    init = init.expression;
  const value = unwrapExpression(init);
  return value.type === "ObjectExpression" && !hasNullPrototype(value);
}
