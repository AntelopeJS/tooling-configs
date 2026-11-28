import type { ESTree, SourceCode } from "@oxlint/plugins";

import {
  classField,
  resolveVariable,
  unwrapExpression,
} from "./local-types.ts";
import { callName } from "./shared.ts";

function isProtoKey(key: ESTree.PropertyKey): boolean {
  return (
    (key.type === "Identifier" && key.name === "__proto__") ||
    (key.type === "Literal" && key.value === "__proto__")
  );
}

/** An object literal with `__proto__: null`, or `Object.create(null)`, behind `as` and `satisfies`. */
export function isNullPrototype(init: ESTree.Expression): boolean {
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

/** A local `const` or class field built with a null prototype, so no read of it reaches `Object.prototype`. */
export function isNullPrototypeTable(
  node: ESTree.Expression,
  source: SourceCode,
): boolean {
  const value = unwrapExpression(node);
  if (
    value.type === "MemberExpression" &&
    !value.computed &&
    value.object.type === "ThisExpression" &&
    value.property.type === "Identifier"
  ) {
    const init = classField(value, value.property.name)?.value;
    return init != null && isNullPrototype(init);
  }
  if (value.type !== "Identifier") return false;
  const [definition] = resolveVariable(source, value)?.defs ?? [];
  return (
    definition?.type === "Variable" &&
    definition.parent?.type === "VariableDeclaration" &&
    definition.parent.kind === "const" &&
    definition.node.type === "VariableDeclarator" &&
    definition.node.init !== null &&
    isNullPrototype(definition.node.init)
  );
}
