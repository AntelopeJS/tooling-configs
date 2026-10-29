import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

/** The type aliases and interfaces a file declares at its top level, by name. */
export interface LocalTypes {
  aliases: Map<string, ESTree.TSType>;
  interfaces: Map<string, ESTree.TSInterfaceDeclaration[]>;
}

type FunctionNode = ESTree.ArrowFunctionExpression | ESTree.Function;

/** Collects top-level and exported type declarations; local ones inside functions are not resolved. */
export function collectLocalTypes(program: ESTree.Program): LocalTypes {
  const types: LocalTypes = { aliases: new Map(), interfaces: new Map() };
  for (const statement of program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
    if (declaration?.type === "TSTypeAliasDeclaration")
      types.aliases.set(declaration.id.name, declaration.typeAnnotation);
    if (declaration?.type === "TSInterfaceDeclaration") {
      const merged = types.interfaces.get(declaration.id.name) ?? [];
      merged.push(declaration);
      types.interfaces.set(declaration.id.name, merged);
    }
  }
  return types;
}

/** The type reference's name when it is a plain identifier, such as `Record` in `Record<string, T>`. */
export function referenceName(type: ESTree.TSTypeReference): string | null {
  return type.typeName.type === "Identifier" ? type.typeName.name : null;
}

/** Strips parentheses and non-null assertions, which change neither the value nor its prototype. */
export function unwrapExpression(node: ESTree.Expression): ESTree.Expression {
  let current = node;
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSNonNullExpression"
  )
    current = current.expression;
  return current;
}

/** The variable an identifier refers to, found by walking out from its scope. */
export function resolveVariable(
  source: SourceCode,
  identifier: ESTree.Node & { name: string },
): Variable | null {
  let scope: Scope | null = source.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

/** The nearest function around a node, or null at module level. */
export function enclosingFunction(node: ESTree.Node): FunctionNode | null {
  let current: ESTree.Node | null = node.parent;
  while (current !== null) {
    if (
      current.type === "ArrowFunctionExpression" ||
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression"
    )
      return current;
    current = current.parent;
  }
  return null;
}

/** The predicate a function's return type declares, when it names a parameter (`x is T`, `asserts x is T`). */
export function parameterPredicate(
  fn: FunctionNode,
): ESTree.TSTypePredicate | null {
  const predicate = fn.returnType?.typeAnnotation;
  return predicate?.type === "TSTypePredicate" &&
    predicate.parameterName.type === "Identifier"
    ? predicate
    : null;
}

/** The parameter name a predicate narrows, or null for `this` predicates. */
export function predicateName(
  predicate: ESTree.TSTypePredicate,
): string | null {
  return predicate.parameterName.type === "Identifier"
    ? predicate.parameterName.name
    : null;
}

/** The field `this.<name>` refers to: a property or constructor parameter property of the class around `node`. */
export function classField(
  node: ESTree.Node,
  name: string,
): {
  typeAnnotation: ESTree.TSTypeAnnotation | null;
  value: ESTree.Expression | null;
} | null {
  let current: ESTree.Node | null = node.parent;
  while (current !== null && current.type !== "ClassBody") {
    if (
      current.type === "FunctionDeclaration" ||
      (current.type === "FunctionExpression" &&
        current.parent.type !== "MethodDefinition")
    )
      return null;
    current = current.parent;
  }
  if (current === null) return null;
  for (const member of current.body) {
    if (
      member.type === "PropertyDefinition" &&
      !member.computed &&
      member.key.type === "Identifier" &&
      member.key.name === name
    )
      return {
        typeAnnotation: member.typeAnnotation ?? null,
        value: member.value,
      };
    if (member.type === "MethodDefinition" && member.kind === "constructor") {
      for (const parameter of member.value.params) {
        if (
          parameter.type === "TSParameterProperty" &&
          parameter.parameter.type === "Identifier" &&
          parameter.parameter.name === name
        )
          return {
            typeAnnotation: parameter.parameter.typeAnnotation ?? null,
            value: null,
          };
      }
    }
  }
  return null;
}
