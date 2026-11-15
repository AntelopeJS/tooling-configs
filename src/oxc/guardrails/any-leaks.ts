import ts from "../../typescript6.ts";

const UNTYPED = ts.TypeFlags.Any | ts.TypeFlags.Unknown;

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

/** Whether `type` is an object type, such as an interface, a reference or an anonymous type. */
export function isObjectType(type: ts.Type): type is ts.ObjectType {
  return (type.flags & ts.TypeFlags.Object) !== 0;
}

/** Whether `type` is a reference to a generic type, such as `Set<string>`, an array or a tuple. */
export function isReference(type: ts.ObjectType): type is ts.TypeReference {
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
 * that sends the value, lets `new Map()` in. A pair of types is compared once,
 * however deep, as tsgolint compares it.
 */
export function leaks(
  checker: ts.TypeChecker,
  sender: ts.Type,
  receiver: ts.Type | undefined,
  node?: ts.Node,
): boolean {
  if (isEmptyMap(node)) return false;
  const compared = new Map<ts.Type, Set<ts.Type>>();
  function compare(from: ts.Type, to: ts.Type | undefined): boolean {
    if (isAnyType(checker, from)) return to === undefined || !takesAnything(to);
    if (to === undefined) return false;
    const seen = compared.get(from) ?? new Set<ts.Type>();
    if (seen.has(to)) return false;
    compared.set(from, seen.add(to));
    const sent = reference(from);
    const slot = reference(to);
    if (sent === undefined || slot === undefined || sent.target !== slot.target)
      return false;
    const slots = checker.getTypeArguments(slot);
    return checker
      .getTypeArguments(sent)
      .some((argument, index) => compare(argument, slots[index]));
  }
  return compare(sender, receiver);
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
