import ts from "@typescript/typescript6";

const UNTYPED = ts.TypeFlags.Any | ts.TypeFlags.Unknown;
const MAX_DEPTH = 4;

/** Whether `type` is `any` itself, not an error type from an import the program cannot resolve, such as another component. */
export function isAnyType(checker: ts.TypeChecker, type: ts.Type): boolean {
  return type === checker.getAnyType();
}

/** Whether `type` is `unknown`. */
export function isUnknown(type: ts.Type | undefined): boolean {
  return type !== undefined && (type.flags & ts.TypeFlags.Unknown) !== 0;
}

/** The element type of an array or a readonly array, whether or not an alias names it, `undefined` for another type. */
export function arrayElement(
  checker: ts.TypeChecker,
  type: ts.Type,
): ts.Type | undefined {
  return checker.isArrayType(type)
    ? checker.getIndexTypeOfType(type, ts.IndexKind.Number)
    : undefined;
}

/** Whether `type` is undeclared, `any` or `unknown`, an error type included. */
export function takesAnything(type: ts.Type | undefined): boolean {
  return type === undefined || (type.flags & UNTYPED) !== 0;
}

function isObjectType(type: ts.Type): type is ts.ObjectType {
  return (type.flags & ts.TypeFlags.Object) !== 0;
}

function isReference(type: ts.ObjectType): type is ts.TypeReference {
  return (type.objectFlags & ts.ObjectFlags.Reference) !== 0;
}

/**
 * The generic reference `type` is, such as `Set<any>`, `any[]` or a tuple,
 * for comparing by its generic target as tsgolint does. A deferred reference,
 * such as one a type alias names as in `type AA = any[]` or `G<any>`, is not
 * compared, as tsgolint compares only references that are not deferred.
 */
function reference(type: ts.Type): ts.TypeReference | undefined {
  return isObjectType(type) && isReference(type) && type.node === undefined
    ? type
    : undefined;
}

/** Whether `node` is `new Map()`, which the lib types `Map<any, any>` and tsgolint lets into any `Map`. */
function isEmptyMap(node: ts.Node | undefined): boolean {
  return (
    node !== undefined &&
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Map" &&
    node.typeArguments === undefined &&
    (node.arguments === undefined || node.arguments.length === 0)
  );
}

/**
 * Whether a `sender` value lets `any` into a `receiver` slot as an argument,
 * an assignment or a type argument: `any` into a slot that is undeclared or
 * typed neither `any` nor `unknown`, or a generic reference holding `any`, as
 * in `any[]` or `Set<any>`, into one of the same generic target, such as
 * `string[]` or `Set<string>`, with another type in that position. `readonly`
 * and labelled tuples have targets of their own, and `node`, the expression
 * that sends the value, lets `new Map()` in.
 */
export function leaks(
  checker: ts.TypeChecker,
  sender: ts.Type,
  receiver: ts.Type | undefined,
  node?: ts.Node,
  depth = 0,
): boolean {
  if (isAnyType(checker, sender))
    return receiver === undefined || !takesAnything(receiver);
  if (receiver === undefined || depth === MAX_DEPTH || isEmptyMap(node))
    return false;
  const from = reference(sender);
  const to = reference(receiver);
  if (from === undefined || to === undefined || from.target !== to.target)
    return false;
  const slots = checker.getTypeArguments(to);
  return checker
    .getTypeArguments(from)
    .some((argument, index) =>
      leaks(checker, argument, slots[index], undefined, depth + 1),
    );
}

/** Whether `type` is `any` or an array of `any`, as a spread or rest holds it. */
export function isAnyOrAnyArray(
  checker: ts.TypeChecker,
  type: ts.Type,
): boolean {
  const element = arrayElement(checker, type);
  return (
    isAnyType(checker, type) ||
    (element !== undefined && isAnyType(checker, element))
  );
}
