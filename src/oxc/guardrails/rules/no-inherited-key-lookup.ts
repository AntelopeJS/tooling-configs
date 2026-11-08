import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode, Variable } from "@oxlint/plugins";
import {
  classField,
  collectLocalTypes,
  enclosingFunction,
  parameterPredicate,
  predicateName,
  referenceName,
  resolveVariable,
  unwrapExpression,
  type LocalTypes,
} from "../local-types.ts";
import { isKnownKey, isStaticKey } from "../key-provenance.ts";
import { isOwnKeyGuarded } from "../own-key-guard.ts";
import { callName } from "../shared.ts";

/** `dictionary`: typed to take any string key; `literal`: an untyped object literal. */
type TableKind = "dictionary" | "literal";

interface Environment {
  source: SourceCode;
  types: LocalTypes;
}

interface Candidate {
  node: ESTree.Node;
  messageId: "lookup" | "inOperator";
  table: string;
  key: string;
}

const WRAPPER_TYPES = new Set(["Readonly", "Partial", "Required"]);
const MAX_ALIAS_DEPTH = 8;

function isStringKey(type: ESTree.TSType): boolean {
  if (type.type === "TSStringKeyword") return true;
  if (type.type === "TSUnionType") return type.types.some(isStringKey);
  return (
    type.type === "TSTypeReference" && referenceName(type) === "PropertyKey"
  );
}

function hasStringIndex(members: ESTree.TSSignature[]): boolean {
  return members.some(
    (member) =>
      member.type === "TSIndexSignature" &&
      member.parameters.some((parameter) =>
        isStringKey(parameter.typeAnnotation.typeAnnotation),
      ),
  );
}

function isStringKeyedReference(
  type: ESTree.TSTypeReference,
  environment: Environment,
  depth: number,
): boolean {
  const name = referenceName(type);
  if (name === null) return false;
  const alias = environment.types.aliases.get(name);
  if (alias !== undefined)
    return isStringKeyedType(alias, environment, depth + 1);
  const declarations = environment.types.interfaces.get(name);
  if (declarations !== undefined)
    return declarations.some((declaration) =>
      hasStringIndex(declaration.body.body),
    );
  const [first] = type.typeArguments?.params ?? [];
  if (first === undefined) return false;
  if (name === "Record") return isStringKey(first);
  return (
    WRAPPER_TYPES.has(name) && isStringKeyedType(first, environment, depth + 1)
  );
}

function isStringKeyedType(
  type: ESTree.TSType,
  environment: Environment,
  depth = 0,
): boolean {
  if (depth > MAX_ALIAS_DEPTH) return false;
  switch (type.type) {
    case "TSParenthesizedType":
      return isStringKeyedType(type.typeAnnotation, environment, depth);
    case "TSTypeLiteral":
      return hasStringIndex(type.members);
    case "TSMappedType":
      return isStringKey(type.constraint);
    case "TSIntersectionType":
    case "TSUnionType":
      return type.types.some((part) =>
        isStringKeyedType(part, environment, depth),
      );
    case "TSTypeReference":
      return isStringKeyedReference(type, environment, depth);
    case "TSTypeQuery":
      return (
        type.exprName.type === "Identifier" &&
        tableKind(type.exprName, environment, depth + 1) === "dictionary"
      );
    default:
      return false;
  }
}

function isProtoKey(key: ESTree.PropertyKey): boolean {
  return (
    (key.type === "Identifier" && key.name === "__proto__") ||
    (key.type === "Literal" && key.value === "__proto__")
  );
}

function isNullPrototype(init: ESTree.Expression): boolean {
  const value = unwrapExpression(
    init.type === "TSAsExpression" || init.type === "TSSatisfiesExpression"
      ? init.expression
      : init,
  );
  if (value.type === "CallExpression")
    return (
      callName(value.callee) === "Object.create" &&
      value.arguments[0]?.type === "Literal" &&
      value.arguments[0].value === null
    );
  return (
    value.type === "ObjectExpression" &&
    value.properties.some(
      (property) =>
        property.type === "Property" &&
        !property.computed &&
        isProtoKey(property.key) &&
        property.value.type === "Literal" &&
        property.value.value === null,
    )
  );
}

function initializerKind(
  init: ESTree.Expression,
  environment: Environment,
  depth: number,
): TableKind | null {
  if (init.type === "TSSatisfiesExpression")
    return isStringKeyedType(init.typeAnnotation, environment, depth)
      ? "dictionary"
      : initializerKind(init.expression, environment, depth);
  if (init.type === "TSAsExpression") {
    if (
      init.typeAnnotation.type === "TSTypeReference" &&
      referenceName(init.typeAnnotation) === "const"
    )
      return initializerKind(init.expression, environment, depth);
    return isStringKeyedType(init.typeAnnotation, environment, depth)
      ? "dictionary"
      : null;
  }
  return unwrapExpression(init).type === "ObjectExpression" ? "literal" : null;
}

function annotationOf(
  definition: Variable["defs"][number],
): ESTree.TSType | undefined {
  const name = definition.name;
  return name.type === "Identifier" && "typeAnnotation" in name
    ? (name.typeAnnotation?.typeAnnotation ?? undefined)
    : undefined;
}

function variableKind(
  variable: Variable,
  environment: Environment,
  depth: number,
): TableKind | null {
  const [definition] = variable.defs;
  if (definition === undefined) return null;
  const annotation = annotationOf(definition);
  if (definition.type === "Parameter")
    return annotation !== undefined &&
      isStringKeyedType(annotation, environment, depth)
      ? "dictionary"
      : null;
  if (
    definition.type !== "Variable" ||
    definition.node.type !== "VariableDeclarator"
  )
    return null;
  const declared = declaredKind(
    annotation,
    definition.node.init,
    environment,
    depth,
  );
  if (
    declared !== null ||
    depth >= MAX_ALIAS_DEPTH ||
    definition.parent?.type !== "VariableDeclaration" ||
    definition.parent.kind !== "const" ||
    definition.node.init === null ||
    !isOpaqueAnnotation(annotation)
  )
    return declared;
  return tableKind(widened(definition.node.init), environment, depth + 1);
}

/** The value under `as unknown` and `as any` casts, which widen the type without changing the value. */
function widened(init: ESTree.Expression): ESTree.Expression {
  let value = init;
  while (
    value.type === "TSAsExpression" &&
    isOpaqueAnnotation(value.typeAnnotation)
  )
    value = value.expression;
  return value;
}

/** No annotation, `unknown` or `any`: the alias holds whatever its initializer holds. */
function isOpaqueAnnotation(annotation: ESTree.TSType | undefined): boolean {
  return (
    annotation === undefined ||
    annotation.type === "TSUnknownKeyword" ||
    annotation.type === "TSAnyKeyword"
  );
}

/** The table a field declares, given its type annotation and initializer. */
function declaredKind(
  annotation: ESTree.TSType | undefined,
  init: ESTree.Expression | null,
  environment: Environment,
  depth: number,
): TableKind | null {
  if (init !== null && isNullPrototype(init)) return null;
  if (annotation !== undefined)
    return isStringKeyedType(annotation, environment, depth)
      ? "dictionary"
      : null;
  return init === null ? null : initializerKind(init, environment, depth);
}

function fieldKind(
  node: ESTree.MemberExpression,
  environment: Environment,
  depth: number,
): TableKind | null {
  if (
    node.computed ||
    node.object.type !== "ThisExpression" ||
    node.property.type !== "Identifier"
  )
    return null;
  const field = classField(node, node.property.name);
  if (field === null) return null;
  return declaredKind(
    field.typeAnnotation?.typeAnnotation ?? undefined,
    field.value,
    environment,
    depth,
  );
}

function tableKind(
  node: ESTree.Expression | ESTree.IdentifierReference,
  environment: Environment,
  depth = 0,
): TableKind | null {
  const value = node.type === "Identifier" ? node : unwrapExpression(node);
  if (value.type === "ConditionalExpression") {
    const kinds = [value.consequent, value.alternate].map((branch) =>
      tableKind(branch, environment, depth),
    );
    if (kinds.includes("dictionary")) return "dictionary";
    return kinds.includes("literal") ? "literal" : null;
  }
  if (value.type === "MemberExpression")
    return fieldKind(value, environment, depth);
  if (value.type !== "Identifier") return null;
  const variable = resolveVariable(environment.source, value);
  return variable === null ? null : variableKind(variable, environment, depth);
}

function isWrite(node: ESTree.MemberExpression): boolean {
  const parent = node.parent;
  if (parent.type === "AssignmentExpression")
    return parent.left === node && parent.operator === "=";
  if (parent.type === "UnaryExpression") return parent.operator === "delete";
  return (
    (parent.type === "ForInStatement" || parent.type === "ForOfStatement") &&
    parent.left === node
  );
}

function isPredicateKey(node: ESTree.BinaryExpression): boolean {
  const fn = enclosingFunction(node);
  const predicate = fn === null ? null : parameterPredicate(fn);
  return (
    predicate !== null &&
    node.left.type === "Identifier" &&
    predicateName(predicate) === node.left.name
  );
}

/** The value a `const { [key]: x } = value` declaration or `({ [key]: x } = value)` assignment reads. */
function destructuredValue(
  pattern: ESTree.ObjectPattern,
): ESTree.Expression | null {
  const parent = pattern.parent;
  if (parent.type === "VariableDeclarator")
    return parent.id === pattern ? parent.init : null;
  return parent.type === "AssignmentExpression" && parent.left === pattern
    ? parent.right
    : null;
}

/** A destructured binding nothing reads, such as `_removed` in `const { [key]: _removed, ...rest } = table`. */
function isDiscarded(value: ESTree.Node, source: SourceCode): boolean {
  if (value.type !== "Identifier") return false;
  const variable = resolveVariable(source, value);
  return (
    variable !== null &&
    !variable.references.some((reference) => reference.isRead())
  );
}

/** Lookups into string-keyed object tables must not answer inherited `Object.prototype` keys. */
export const noInheritedKeyLookupRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow reading a string-keyed object table with a computed key, or testing it with `in`, without an own-key check.",
    },
    messages: {
      lookup:
        "`{{ table }}` is a string-keyed object table, so `{{ table }}[{{ key }}]` also answers keys inherited from `Object.prototype` such as `constructor` and `toString`. Store the table in a `Map` and call `.get({{ key }})`, check `Object.hasOwn({{ table }}, {{ key }})` before the read, or build the table with a null prototype (`Object.create(null)` or `{ __proto__: null, ... }`).",
      inOperator:
        "`{{ key }} in {{ table }}` is also true for keys inherited from `Object.prototype` such as `constructor` and `toString`. Use `Object.hasOwn({{ table }}, {{ key }})`, or store the table in a `Map` and call `.has({{ key }})`.",
    },
  },
  createOnce(context) {
    let environment: Environment | null = null;
    const report = (candidate: Candidate): void => {
      if (
        !isOwnKeyGuarded(
          candidate.node,
          candidate.table,
          candidate.key,
          context.sourceCode,
        )
      )
        context.report({
          node: candidate.node,
          messageId: candidate.messageId,
          data: { table: candidate.table, key: candidate.key },
        });
    };
    const lookup = (
      node: ESTree.Node,
      object: ESTree.Expression,
      key: ESTree.Node,
    ): void => {
      if (environment === null) return;
      const kind = tableKind(object, environment);
      if (
        kind === null ||
        (kind === "literal" && key.type !== "TSAsExpression")
      )
        return;
      const table = context.sourceCode.getText(object);
      if (isKnownKey(key, table, context.sourceCode)) return;
      report({
        node,
        messageId: "lookup",
        table,
        key: context.sourceCode.getText(key),
      });
    };
    return {
      Program(node) {
        environment = {
          source: context.sourceCode,
          types: collectLocalTypes(node),
        };
      },
      MemberExpression(node) {
        if (node.computed && !isWrite(node))
          lookup(node, node.object, node.property);
      },
      ObjectPattern(node) {
        const object = destructuredValue(node);
        if (object === null) return;
        for (const property of node.properties)
          if (
            property.type === "Property" &&
            property.computed &&
            !isDiscarded(property.value, context.sourceCode)
          )
            lookup(property, object, property.key);
      },
      BinaryExpression(node) {
        if (
          environment === null ||
          node.operator !== "in" ||
          isStaticKey(node.left) ||
          isPredicateKey(node) ||
          tableKind(node.right, environment) === null
        )
          return;
        report({
          node,
          messageId: "inOperator",
          table: context.sourceCode.getText(node.right),
          key: context.sourceCode.getText(node.left),
        });
      },
    };
  },
});
