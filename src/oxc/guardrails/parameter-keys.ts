import type { ESTree, SourceCode } from "@oxlint/plugins";
import ts from "../../typescript6.ts";

import { resolveVariable, unwrapExpression } from "./local-types.ts";
import { isNullPrototypeTable } from "./null-prototype.ts";
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

function isPlainStringAnnotation(type: ESTree.TSType): boolean {
  if (type.type === "TSStringKeyword") return true;
  return (
    type.type === "TSUnionType" &&
    type.types.some((member) => member.type === "TSStringKeyword") &&
    type.types.every(
      (member) =>
        member.type === "TSStringKeyword" ||
        member.type === "TSUndefinedKeyword" ||
        member.type === "TSNullKeyword",
    )
  );
}

/** A key read from a parameter or variable annotated `string`, `string | undefined` or `string | null`, whatever the table it reads. */
function isDeclaredStringKey(key: ESTree.Node, source: SourceCode): boolean {
  if (key.type !== "Identifier") return false;
  const [definition] = resolveVariable(source, key)?.defs ?? [];
  if (definition?.type !== "Parameter" && definition?.type !== "Variable")
    return false;
  const name = definition.name;
  const annotation =
    name.type === "Identifier" && "typeAnnotation" in name
      ? name.typeAnnotation?.typeAnnotation
      : undefined;
  return annotation != null && isPlainStringAnnotation(annotation);
}

/** A call that takes `key` as an argument, alone or on either side of `&&`. */
function callsWithKey(test: ESTree.Node, key: string): boolean {
  if (test.type === "ParenthesizedExpression")
    return callsWithKey(test.expression, key);
  if (test.type === "LogicalExpression" && test.operator === "&&")
    return callsWithKey(test.left, key) || callsWithKey(test.right, key);
  return (
    test.type === "CallExpression" &&
    test.arguments.some(
      (argument) => argument.type === "Identifier" && argument.name === key,
    )
  );
}

/** Whether a call on `key` decides a conditional, `if` or `&&` whose branch holds `node`, as in `isLevelName(level) ? map[level] : fallback`. */
function isNarrowedByCall(node: ESTree.Node, key: string): boolean {
  let child = node;
  let parent: ESTree.Node | null = node.parent;
  while (parent !== null) {
    if (
      ((parent.type === "ConditionalExpression" ||
        parent.type === "IfStatement") &&
        child === parent.consequent &&
        callsWithKey(parent.test, key)) ||
      (parent.type === "LogicalExpression" &&
        parent.operator === "&&" &&
        child === parent.right &&
        callsWithKey(parent.left, key))
    )
      return true;
    child = parent;
    parent = parent.parent;
  }
  return false;
}

/** A key declared as a plain string that no enclosing call narrows, read from a table other than `Object.prototype` and not built with a null prototype. */
export function isUnnarrowedStringKey(
  node: ESTree.Node,
  object: ESTree.Expression,
  key: ESTree.Node,
  source: SourceCode,
): boolean {
  return (
    key.type === "Identifier" &&
    source.getText(object) !== "Object.prototype" &&
    isDeclaredStringKey(key, source) &&
    !isNarrowedByCall(node, key.name) &&
    !isNullPrototypeTable(object, source)
  );
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
