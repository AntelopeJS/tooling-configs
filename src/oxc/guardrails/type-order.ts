import ts from "typescript";

function isObject(type: ts.Type): type is ts.ObjectType {
  return (type.flags & ts.TypeFlags.Object) !== 0;
}

function isReference(type: ts.Type): type is ts.TypeReference {
  return isObject(type) && (type.objectFlags & ts.ObjectFlags.Reference) !== 0;
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** The symbol tsgo orders a type by name: its alias's, or its own for a type parameter, a class, an interface or a reference. */
function nameSymbol(type: ts.Type): ts.Symbol | undefined {
  if (type.aliasSymbol !== undefined) return type.aliasSymbol;
  const named =
    (type.flags & ts.TypeFlags.TypeParameter) !== 0 ||
    (isObject(type) &&
      (type.objectFlags &
        (ts.ObjectFlags.ClassOrInterface | ts.ObjectFlags.Reference)) !==
        0);
  return named ? type.getSymbol() : undefined;
}

/** Nodes by position in one file. Nodes in different files compare equal, as the order tsgo gives its program's files is not this program's. */
function compareNodes(a: ts.Node | undefined, b: ts.Node | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a.getSourceFile() === b.getSourceFile() ? a.pos - b.pos : 0;
}

function compareSymbols(
  a: ts.Symbol | undefined,
  b: ts.Symbol | undefined,
): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  const first = a.declarations?.[0];
  const second = b.declarations?.[0];
  if (first !== undefined && second !== undefined) {
    const byNode = compareNodes(first, second);
    if (byNode !== 0) return byNode;
  } else if (first !== undefined) return -1;
  else if (second !== undefined) return 1;
  return compareText(a.name, b.name);
}

/**
 * The order tsgo, the checker tsgolint runs, gives the members of a union:
 * by type flags, then named types by name, unnamed ones after them, then
 * object types by their symbol's declaration, references first, and
 * intersections by their members. Where tsgo falls back to type creation
 * order this keeps the order the types already have, as a TypeScript 6 union
 * lists its members in creation order. So does a tie tsgo breaks with data
 * TypeScript 6 keeps internal: the type mappers of two instantiations of one
 * anonymous type, and the file order of tsgo's program.
 */
export function typeOrder(
  checker: ts.TypeChecker,
): (a: ts.Type, b: ts.Type) => number {
  function compareLists(
    a: readonly ts.Type[] | undefined,
    b: readonly ts.Type[] | undefined,
  ): number {
    const first = a ?? [];
    const second = b ?? [];
    if (first.length !== second.length) return first.length - second.length;
    for (const [index, type] of first.entries()) {
      const other = second[index];
      const order = other === undefined ? 0 : compare(type, other);
      if (order !== 0) return order;
    }
    return 0;
  }
  function compareNames(a: ts.Type, b: ts.Type): number {
    const first = nameSymbol(a);
    const second = nameSymbol(b);
    if (first === second)
      return a.aliasSymbol === undefined
        ? 0
        : compareLists(a.aliasTypeArguments, b.aliasTypeArguments);
    if (first === undefined) return 1;
    if (second === undefined) return -1;
    return compareText(first.name, second.name);
  }
  function compareObjects(a: ts.ObjectType, b: ts.ObjectType): number {
    const bySymbol = compareSymbols(a.getSymbol(), b.getSymbol());
    if (bySymbol !== 0) return bySymbol;
    if (isReference(a) && isReference(b))
      return a.node === undefined && b.node === undefined
        ? compareLists(checker.getTypeArguments(a), checker.getTypeArguments(b))
        : compareNodes(a.node, b.node);
    if (isReference(a)) return -1;
    return isReference(b) ? 1 : 0;
  }
  function compare(a: ts.Type, b: ts.Type): number {
    if (a === b) return 0;
    if (a.flags !== b.flags) return a.flags - b.flags;
    const byName = compareNames(a, b);
    if (byName !== 0) return byName;
    if (isObject(a) && isObject(b)) return compareObjects(a, b);
    if (a.isUnionOrIntersection() && b.isUnionOrIntersection())
      return compareLists(a.types, b.types);
    if (a.isStringLiteral() && b.isStringLiteral())
      return compareText(a.value, b.value);
    return a.isNumberLiteral() && b.isNumberLiteral() ? a.value - b.value : 0;
  }
  return compare;
}
