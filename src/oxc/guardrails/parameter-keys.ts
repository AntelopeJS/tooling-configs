import type { ESTree, SourceCode } from "@oxlint/plugins";
import {
  referenceName,
  resolveVariable,
  unwrapExpression,
  type LocalTypes,
} from "./local-types.ts";

const MAX_DEPTH = 8;

function declaresTypeParameter(node: ESTree.Node, name: string): boolean {
  let current: ESTree.Node | null = node;
  while (current !== null) {
    if (
      "typeParameters" in current &&
      current.typeParameters?.type === "TSTypeParameterDeclaration" &&
      current.typeParameters.params.some(
        (parameter) => parameter.name.name === name,
      )
    )
      return true;
    current = current.parent;
  }
  return false;
}

function mayBeArbitraryString(
  type: ESTree.TSType,
  fn: ESTree.Node,
  types: LocalTypes,
  depth = 0,
): boolean {
  if (depth > MAX_DEPTH) return false;
  switch (type.type) {
    case "TSStringKeyword":
      return true;
    case "TSParenthesizedType":
      return mayBeArbitraryString(type.typeAnnotation, fn, types, depth + 1);
    case "TSUnionType":
      return type.types.some((part) =>
        mayBeArbitraryString(part, fn, types, depth + 1),
      );
    case "TSTypeReference": {
      const name = referenceName(type);
      if (name === null) return false;
      if (name === "PropertyKey") return true;
      const alias = types.aliases.get(name);
      if (alias !== undefined)
        return mayBeArbitraryString(alias, fn, types, depth + 1);
      if (types.interfaces.has(name) || types.enums.has(name)) return false;
      return !declaresTypeParameter(fn, name);
    }
    default:
      return false;
  }
}

/** A parameter declared with a type that can hold an arbitrary string: `string`, `PropertyKey`, or a type this file cannot resolve. */
export function isOpenStringParameter(
  key: ESTree.Node,
  source: SourceCode,
  types: LocalTypes,
): boolean {
  if (key.type !== "Identifier") return false;
  const [definition] = resolveVariable(source, key)?.defs ?? [];
  if (definition?.type !== "Parameter") return false;
  const name = definition.name;
  const annotation =
    name.type === "Identifier"
      ? name.typeAnnotation?.typeAnnotation
      : undefined;
  return (
    annotation !== undefined &&
    mayBeArbitraryString(annotation, definition.node, types)
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
