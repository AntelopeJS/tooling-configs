import type { ESTree, SourceCode } from "@oxlint/plugins";

import { resolveVariable } from "./local-types.ts";
import { callName } from "./shared.ts";

/** Whether an options argument sets `conflict` to anything but `"error"`, which makes the insert an upsert. */
export function isUpsert(node: ESTree.CallExpression): boolean {
  return node.arguments
    .slice(1)
    .some(
      (argument) =>
        argument.type === "ObjectExpression" &&
        argument.properties.some(
          (property) =>
            property.type === "Property" &&
            !property.computed &&
            ((property.key.type === "Identifier" &&
              property.key.name === "conflict") ||
              (property.key.type === "Literal" &&
                property.key.value === "conflict")) &&
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
      if (
        property.type !== "Property" ||
        property.computed ||
        !(
          (property.key.type === "Identifier" && property.key.name === "_id") ||
          (property.key.type === "Literal" && property.key.value === "_id")
        )
      )
        continue;
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
