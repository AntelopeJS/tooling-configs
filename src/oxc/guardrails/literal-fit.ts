import ts from "@typescript/typescript6";

const MAX_DEPTH = 8;
const INDEX = /^\d+$/u;

/** The type a written value has: a shorthand property reads its variable, as a direct assignment would. */
export function valueType(
  checker: ts.TypeChecker,
  value: ts.Expression,
): ts.Type {
  const shorthand =
    ts.isShorthandPropertyAssignment(value.parent) &&
    value.parent.name === value
      ? checker.getShorthandAssignmentValueSymbol(value.parent)
      : undefined;
  return shorthand === undefined
    ? checker.getTypeAtLocation(value)
    : checker.getTypeOfSymbolAtLocation(shorthand, value);
}

function propertyName(
  property: ts.ObjectLiteralElementLike,
): { name: string; value: ts.Expression } | undefined {
  if (
    !(
      ts.isPropertyAssignment(property) ||
      ts.isShorthandPropertyAssignment(property)
    ) ||
    !(
      ts.isIdentifier(property.name) ||
      ts.isStringLiteral(property.name) ||
      ts.isNumericLiteral(property.name)
    )
  )
    return undefined;
  return {
    name: property.name.text,
    value: ts.isPropertyAssignment(property)
      ? property.initializer
      : property.name,
  };
}

function objectFits(
  checker: ts.TypeChecker,
  literal: ts.ObjectLiteralExpression,
  type: ts.Type,
  depth: number,
): boolean {
  const names = new Set<string>();
  for (const property of literal.properties) {
    const named = propertyName(property);
    if (named === undefined) return false;
    names.add(named.name);
    const field = checker.getPropertyOfType(type, named.name);
    const fieldType =
      field === undefined
        ? checker.getIndexTypeOfType(type, ts.IndexKind.String)
        : checker.getTypeOfSymbolAtLocation(field, literal);
    if (
      fieldType === undefined ||
      !literalFits(checker, named.value, fieldType, depth + 1)
    )
      return false;
  }
  return checker
    .getPropertiesOfType(type)
    .every(
      (field) =>
        (field.flags & ts.SymbolFlags.Optional) !== 0 || names.has(field.name),
    );
}

function arrayFits(
  checker: ts.TypeChecker,
  literal: ts.ArrayLiteralExpression,
  type: ts.Type,
  depth: number,
): boolean {
  const { elements } = literal;
  if (
    elements.some(
      (element) =>
        ts.isSpreadElement(element) || ts.isOmittedExpression(element),
    )
  )
    return false;
  if (checker.isTupleType(type)) {
    const slots = checker
      .getPropertiesOfType(type)
      .filter((slot) => INDEX.test(slot.name));
    const required = slots.filter(
      (slot) => (slot.flags & ts.SymbolFlags.Optional) === 0,
    );
    return (
      elements.length >= required.length &&
      elements.length <= slots.length &&
      elements.every((element, index) =>
        literalFits(
          checker,
          element,
          checker.getTypeOfSymbolAtLocation(slots[index], literal),
          depth + 1,
        ),
      )
    );
  }
  const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  return (
    element !== undefined &&
    elements.every((value) => literalFits(checker, value, element, depth + 1))
  );
}

/**
 * Whether `expression` fits `type` the way a direct assignment types it:
 * literals inside object and array literals keep their literal types, which
 * `Object.assign`'s inferred source type widens. Object literals need every
 * required property and no undeclared one, tuples their length. Past the
 * depth cap a literal fits, so the rule stays silent rather than wrong.
 */
export function literalFits(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  type: ts.Type,
  depth = 0,
): boolean {
  let value = expression;
  while (ts.isParenthesizedExpression(value)) value = value.expression;
  if (checker.isTypeAssignableTo(valueType(checker, value), type)) return true;
  if (
    !ts.isObjectLiteralExpression(value) &&
    !ts.isArrayLiteralExpression(value)
  )
    return false;
  if (depth === MAX_DEPTH) return true;
  if (type.isUnion())
    return type.types.some((member) =>
      literalFits(checker, value, member, depth),
    );
  return ts.isObjectLiteralExpression(value)
    ? objectFits(checker, value, type, depth)
    : arrayFits(checker, value, type, depth);
}
