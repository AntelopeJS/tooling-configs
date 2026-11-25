import type { ESTree, SourceCode } from "@oxlint/plugins";
import {
  referenceName,
  resolveVariable,
  unwrapExpression,
  type LocalTypes,
} from "./local-types.ts";

const MAX_DEPTH = 8;

function enclosingTypeParameter(
  node: ESTree.Node,
  name: string,
): ESTree.TSTypeParameter | null {
  let current: ESTree.Node | null = node;
  while (current !== null) {
    if (
      "typeParameters" in current &&
      current.typeParameters?.type === "TSTypeParameterDeclaration"
    ) {
      const parameter = current.typeParameters.params.find(
        (candidate) => candidate.name.name === name,
      );
      if (parameter !== undefined) return parameter;
    }
    current = current.parent;
  }
  return null;
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
      const parameter = enclosingTypeParameter(fn, name);
      if (parameter !== null)
        return (
          parameter.constraint === null ||
          mayBeArbitraryString(
            parameter.constraint,
            parameter,
            types,
            depth + 1,
          )
        );
      const alias = types.aliases.get(name);
      if (alias !== undefined)
        return mayBeArbitraryString(alias, fn, types, depth + 1);
      return !types.interfaces.has(name) && !types.enums.has(name);
    }
    default:
      return false;
  }
}

/** A parameter declared with a type that can hold an arbitrary string: `string`, `PropertyKey`, a type parameter whose constraint is open or missing, or a type this file cannot resolve. */
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
