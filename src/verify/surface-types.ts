import ts from "typescript";

const NAMED =
  ts.SymbolFlags.Interface |
  ts.SymbolFlags.Class |
  ts.SymbolFlags.Enum |
  ts.SymbolFlags.TypeAlias;

function isObjectType(type: ts.Type): type is ts.ObjectType {
  return (type.flags & ts.TypeFlags.Object) !== 0;
}

function isReference(type: ts.ObjectType): type is ts.TypeReference {
  return (type.objectFlags & ts.ObjectFlags.Reference) !== 0;
}

function isPublicMember(member: ts.ClassElement): boolean {
  const hidden = ts.ModifierFlags.Private | ts.ModifierFlags.Protected;
  return (
    (ts.getCombinedModifierFlags(member) & hidden) === 0 &&
    !(member.name !== undefined && ts.isPrivateIdentifier(member.name))
  );
}

/** A class declaration reduced to the members a consumer can reach; any other declaration as it is. */
function publicPart(declaration: ts.Declaration): ts.Node {
  if (!ts.isClassDeclaration(declaration)) return declaration;
  return ts.factory.updateClassDeclaration(
    declaration,
    declaration.modifiers,
    declaration.name,
    declaration.typeParameters,
    declaration.heritageClauses,
    declaration.members.filter(isPublicMember),
  );
}

/** Walks the types a set of signatures reaches and prints every declaration of the package among them. */
class DeclarationWalk {
  private readonly declarations = new Map<ts.Symbol, string>();
  private readonly seen = new Set<ts.Type>();
  private readonly printer = ts.createPrinter({ removeComments: true });
  private readonly checker: ts.TypeChecker;
  private readonly isLocal: (symbol: ts.Symbol) => boolean;

  constructor(
    checker: ts.TypeChecker,
    isLocal: (symbol: ts.Symbol) => boolean,
  ) {
    this.checker = checker;
    this.isLocal = isLocal;
  }

  get found(): string[] {
    return [...this.declarations.values()];
  }

  signature(signature: ts.Signature): void {
    for (const parameter of signature.getTypeParameters() ?? [])
      this.type(parameter);
    for (const parameter of signature.getParameters())
      this.type(this.checker.getTypeOfSymbol(parameter));
    this.type(signature.getReturnType());
  }

  private record(symbol: ts.Symbol): void {
    if (
      this.declarations.has(symbol) ||
      (symbol.flags & NAMED) === 0 ||
      !this.isLocal(symbol)
    )
      return;
    const texts = (symbol.declarations ?? []).map((declaration) =>
      this.printer
        .printNode(
          ts.EmitHint.Unspecified,
          publicPart(declaration),
          declaration.getSourceFile(),
        )
        .replace(/\s+/g, " ")
        .replace(/^(?:export )?(?:declare )?/, ""),
    );
    this.declarations.set(symbol, texts.join(" "));
    for (const declaration of symbol.declarations ?? [])
      this.generics(declaration);
  }

  private generics(declaration: ts.Declaration): void {
    if (
      ts.isClassDeclaration(declaration) ||
      ts.isInterfaceDeclaration(declaration) ||
      ts.isTypeAliasDeclaration(declaration)
    )
      for (const parameter of declaration.typeParameters ?? [])
        this.type(this.checker.getTypeAtLocation(parameter));
    if (
      ts.isClassDeclaration(declaration) ||
      ts.isInterfaceDeclaration(declaration)
    )
      for (const clause of declaration.heritageClauses ?? [])
        for (const base of clause.types)
          this.type(this.checker.getTypeAtLocation(base));
  }

  private members(type: ts.Type): void {
    for (const property of this.checker.getPropertiesOfType(type))
      this.type(this.checker.getTypeOfSymbol(property));
    for (const signature of [
      ...type.getCallSignatures(),
      ...type.getConstructSignatures(),
    ])
      this.signature(signature);
  }

  type(type: ts.Type): void {
    if (this.seen.has(type)) return;
    this.seen.add(type);
    if (type.isUnionOrIntersection()) {
      for (const part of type.types) this.type(part);
      return;
    }
    if (type.flags & ts.TypeFlags.TypeParameter) {
      this.type(type.getConstraint() ?? type);
      this.type(type.getDefault() ?? type);
      return;
    }
    if (type.aliasSymbol) this.record(type.aliasSymbol);
    for (const argument of type.aliasTypeArguments ?? []) this.type(argument);
    if (isObjectType(type) && isReference(type))
      for (const argument of this.checker.getTypeArguments(type))
        this.type(argument);
    const symbol = type.getSymbol();
    if (symbol === undefined || !this.isLocal(symbol)) return;
    for (const declaration of symbol.declarations ?? []) {
      const owner = ts.isEnumMember(declaration)
        ? this.checker.getSymbolAtLocation(declaration.parent.name)
        : undefined;
      if (owner) this.record(owner);
    }
    this.record(symbol);
    this.members(type);
  }
}

/**
 * The declarations of the package that the signatures reach through their
 * parameter and answer types, transitively, each printed without comments.
 * A change inside one, such as a member's type, changes the functions that
 * reach it.
 */
export function referencedDeclarations(
  checker: ts.TypeChecker,
  isLocal: (symbol: ts.Symbol) => boolean,
  signatures: readonly ts.Signature[],
): string[] {
  const walk = new DeclarationWalk(checker, isLocal);
  for (const signature of signatures) walk.signature(signature);
  return walk.found.sort((left, right) => left.localeCompare(right));
}
