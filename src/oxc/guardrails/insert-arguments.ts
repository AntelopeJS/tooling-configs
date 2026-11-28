import type { ESTree, SourceCode } from "@oxlint/plugins";

import { resolveVariable } from "./local-types.ts";
import { callName } from "./shared.ts";

/** A plain or quoted property key, never a computed one, such as `conflict` or `"conflict"`. */
function isProperty(
  property: ESTree.ObjectExpression["properties"][number],
  name: string,
): property is ESTree.ObjectProperty {
  return (
    property.type === "Property" &&
    !property.computed &&
    ((property.key.type === "Identifier" && property.key.name === name) ||
      (property.key.type === "Literal" && property.key.value === name))
  );
}

/** Whether an options argument sets `conflict` to anything but `"error"`, which makes the insert an upsert. */
export function isUpsert(node: ESTree.CallExpression): boolean {
  return node.arguments
    .slice(1)
    .some(
      (argument) =>
        argument.type === "ObjectExpression" &&
        argument.properties.some(
          (property) =>
            isProperty(property, "conflict") &&
            !(
              property.value.type === "Literal" &&
              property.value.value === "error"
            ),
        ),
    );
}

/** A name bound once to `randomUUID()`, which no other writer can hold. */
function isFreshId(
  source: SourceCode,
  node: ESTree.IdentifierReference,
): boolean {
  const variable = resolveVariable(source, node);
  return (
    variable !== null &&
    !variable.references.some(
      (reference) => reference.isWrite() && !reference.init,
    ) &&
    variable.defs.some(
      ({ node: def }) =>
        def.type === "VariableDeclarator" &&
        def.init?.type === "CallExpression" &&
        /(?:^|\.)randomUUID$/u.test(callName(def.init.callee) ?? ""),
    )
  );
}

/** The `_id` an inserted object literal takes from a name or a member, such as `tenantId` or `creditNote.id`, which another request can hold too. */
export function naturalKey(
  source: SourceCode,
  insert: ESTree.CallExpression,
): ESTree.Node | null {
  const [row] = insert.arguments;
  const rows =
    row?.type === "ArrayExpression"
      ? row.elements
      : row === undefined
        ? []
        : [row];
  for (const element of rows) {
    if (element?.type !== "ObjectExpression") continue;
    for (const property of element.properties) {
      if (!isProperty(property, "_id")) continue;
      const { value } = property;
      if (
        value.type === "MemberExpression" ||
        (value.type === "Identifier" && !isFreshId(source, value))
      )
        return value;
    }
  }
  return null;
}
