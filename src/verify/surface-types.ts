import ts from "typescript";

const NAMED =
  ts.SymbolFlags.Interface |
  ts.SymbolFlags.Class |
  ts.SymbolFlags.Enum |
  ts.SymbolFlags.TypeAlias;

const MODULE = ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule;

const INHERITING = ts.SymbolFlags.Class | ts.SymbolFlags.Interface;

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

/** Whether a heritage expression is a name such as `Base` or `ns.Base`, rather than a call. */
function isEntityName(expression: ts.Expression): boolean {
  return (
    ts.isIdentifier(expression) ||
    (ts.isPropertyAccessExpression(expression) &&
      isEntityName(expression.expression))
  );
}

/** The name a written type reference resolves through, when the node is one. */
function referencedName(node: ts.Node): ts.Node | undefined {
  if (ts.isTypeReferenceNode(node)) return node.typeName;
  if (ts.isExpressionWithTypeArguments(node) && isEntityName(node.expression))
    return node.expression;
  if (ts.isTypeQueryNode(node)) return node.exprName;
  if (!ts.isImportTypeNode(node)) return undefined;
  if (node.qualifier) return node.qualifier;
  return ts.isLiteralTypeNode(node.argument)
    ? node.argument.literal
    : undefined;
}

/** Whether reading the declaration would read a whole module rather than one declaration. */
function isModuleBody(declaration: ts.Declaration): boolean {
  return ts.isSourceFile(declaration) || ts.isModuleDeclaration(declaration);
}

/**
 * Collects the package's declarations a function reaches. The written text of
 * every declaration it meets is read once, and each type reference in it is
 * resolved to its symbol without evaluating a type, so the walk is finite. The
 * root signatures' own types are walked once for what their text does not
 * write: a class instance a constructor answers and the type arguments they
 * were instantiated with.
 */
class DeclarationWalk {
  private readonly declarations = new Map<ts.Symbol, string>();
  private readonly reached = new Set<ts.Symbol>();
  private readonly read = new Set<ts.Symbol>();
  private readonly inherited = new Set<ts.Symbol>();
  private readonly seen = new Set<ts.Type>();
  private readonly unread: ts.Symbol[] = [];
  private readonly types: ts.Type[] = [];
  private readonly printer = ts.createPrinter({ removeComments: true });
  private readonly checker: ts.TypeChecker;
  private readonly isLocalFile: (file: ts.SourceFile) => boolean;

  constructor(
    checker: ts.TypeChecker,
    isLocalFile: (file: ts.SourceFile) => boolean,
  ) {
    this.checker = checker;
    this.isLocalFile = isLocalFile;
  }

  get found(): string[] {
    for (;;) {
      const type = this.types.pop();
      if (type) {
        this.type(type);
        continue;
      }
      const symbol = this.unread.pop();
      if (!symbol) return [...this.declarations.values()];
      for (const declaration of this.local(symbol))
        if (!isModuleBody(declaration)) this.references(declaration);
    }
  }

  signature(signature: ts.Signature): void {
    this.types.push(
      ...(signature.getTypeParameters() ?? []),
      ...signature
        .getParameters()
        .map((parameter) => this.checker.getTypeOfSymbol(parameter)),
      signature.getReturnType(),
    );
  }

  /** Reads what a symbol on the path to the signatures writes of their types: a class's or interface's heritage type arguments, any other symbol's declarations. */
  owner(symbol: ts.Symbol): void {
    if (symbol.flags & INHERITING) this.inherit(symbol);
    else this.open(symbol);
  }

  /** The symbol's declarations in the package, leaving out what lib or a dependency declares of a symbol the package augments. */
  private local(symbol: ts.Symbol): ts.Declaration[] {
    return (symbol.declarations ?? []).filter((declaration) =>
      this.isLocalFile(declaration.getSourceFile()),
    );
  }

  private isLocal(symbol: ts.Symbol): boolean {
    return this.local(symbol).length > 0;
  }

  private resolve(symbol: ts.Symbol): ts.Symbol {
    return symbol.flags & ts.SymbolFlags.Alias
      ? this.checker.getAliasedSymbol(symbol)
      : symbol;
  }

  private record(symbol: ts.Symbol): void {
    if ((symbol.flags & NAMED) === 0) return;
    const texts = this.local(symbol).map((declaration) =>
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
  }

  private open(found: ts.Symbol): void {
    const symbol = this.resolve(found);
    if (this.read.has(symbol) || !this.isLocal(symbol)) return;
    this.read.add(symbol);
    this.unread.push(symbol);
  }

  private inherit(found: ts.Symbol): void {
    const symbol = this.resolve(found);
    if (this.inherited.has(symbol) || !this.isLocal(symbol)) return;
    this.inherited.add(symbol);
    for (const declaration of this.local(symbol)) {
      if (
        !ts.isClassLike(declaration) &&
        !ts.isInterfaceDeclaration(declaration)
      )
        continue;
      for (const clause of declaration.heritageClauses ?? [])
        for (const base of clause.types) {
          this.typeArguments(base);
          for (const owner of this.bases(base.expression)) this.owner(owner);
        }
    }
  }

  /** Reads the type arguments a heritage expression writes, including those inside a call such as `mix<A>(Base<B>)`. */
  private typeArguments(node: ts.Node): void {
    if (ts.isExpressionWithTypeArguments(node)) {
      for (const argument of node.typeArguments ?? [])
        this.references(argument);
      this.typeArguments(node.expression);
    } else if (ts.isTypeNode(node)) this.references(node);
    else ts.forEachChild(node, (child) => this.typeArguments(child));
  }

  /** Records the symbol when it names an interface, class, enum or alias of the package, and queues its declarations to be read, once. */
  reach(found: ts.Symbol): void {
    const symbol = this.resolve(found);
    if (this.reached.has(symbol) || !this.isLocal(symbol)) return;
    this.reached.add(symbol);
    for (const declaration of symbol.declarations ?? []) {
      const owner = ts.isEnumMember(declaration)
        ? this.checker.getSymbolAtLocation(declaration.parent.name)
        : undefined;
      if (owner) this.reach(owner);
    }
    const assigned = symbol.exports?.get(ts.InternalSymbolName.ExportEquals);
    if (assigned) this.reach(assigned);
    if (symbol.flags & MODULE)
      for (const member of this.checker.getExportsOfModule(symbol)) {
        const value = this.resolve(member);
        if (value.flags & ts.SymbolFlags.Value) this.reach(value);
      }
    this.record(symbol);
    this.open(symbol);
  }

  /** The symbols a heritage expression names: the entity it is, or each name in a call such as `Mixin(Base)`. */
  private bases(expression: ts.Node): ts.Symbol[] {
    const symbol =
      ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)
        ? this.checker.getSymbolAtLocation(expression)
        : undefined;
    if (symbol) return [symbol];
    const found: ts.Symbol[] = [];
    ts.forEachChild(expression, (child) => {
      if (!ts.isTypeNode(child)) found.push(...this.bases(child));
    });
    return found;
  }

  private references(node: ts.Node): void {
    const name = referencedName(node);
    const symbol = name && this.checker.getSymbolAtLocation(name);
    if (symbol) this.reach(symbol);
    if (
      ts.isExpressionWithTypeArguments(node) &&
      !isEntityName(node.expression)
    )
      for (const base of this.bases(node.expression)) this.reach(base);
    ts.forEachChild(node, (child) => this.references(child));
  }

  private type(type: ts.Type): void {
    if (this.seen.has(type)) return;
    this.seen.add(type);
    if (type.aliasSymbol) {
      this.reach(type.aliasSymbol);
      this.types.push(...(type.aliasTypeArguments ?? []));
      return;
    }
    if (type.isUnionOrIntersection()) {
      this.types.push(...type.types);
      return;
    }
    if (type.flags & ts.TypeFlags.TypeParameter) {
      this.types.push(type.getConstraint() ?? type, type.getDefault() ?? type);
      return;
    }
    if (isObjectType(type) && isReference(type))
      this.types.push(...this.checker.getTypeArguments(type));
    const symbol = type.getSymbol();
    if (symbol) this.reach(symbol);
  }
}

function declaredNames(statement: ts.Statement): ts.Node[] {
  if (ts.isVariableStatement(statement))
    return statement.declarationList.declarations.map(
      (declaration) => declaration.name,
    );
  if (
    ts.isInterfaceDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isFunctionDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement)
  )
    return statement.name ? [statement.name] : [];
  return [];
}

function moduleStatements(statement: ts.Statement): readonly ts.Statement[] {
  const body = ts.isModuleDeclaration(statement) ? statement.body : undefined;
  if (body && ts.isModuleBlock(body)) return body.statements;
  return body && ts.isModuleDeclaration(body) ? [body] : [];
}

/** Whether a module file's statement opens a scope outside text can see: `declare global`, or `declare module` of a module that is not a package file. */
function opensOutside(
  checker: ts.TypeChecker,
  statement: ts.Statement,
  isLocalFile: (file: ts.SourceFile) => boolean,
): boolean {
  if (!ts.isModuleDeclaration(statement)) return false;
  if (statement.flags & ts.NodeFlags.GlobalAugmentation) return true;
  if (!ts.isStringLiteral(statement.name)) return false;
  const declarations =
    checker.getSymbolAtLocation(statement.name)?.declarations ?? [];
  return !declarations.some(
    (declaration) => ts.isSourceFile(declaration) && isLocalFile(declaration),
  );
}

/**
 * The symbols the package declares where text outside the package can name
 * them: in a script file, in `declare global`, or in `declare module` of a
 * module that is not a package file. These include every augmentation of a
 * lib or dependency symbol. Text outside the package reaches a declaration
 * of the package only through one of them, so every walk reaches them all.
 */
export function outsideVisible(
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  isLocalFile: (file: ts.SourceFile) => boolean,
): ts.Symbol[] {
  const visible = new Set<ts.Symbol>();
  const pending = files.flatMap((file) =>
    ts.isExternalModule(file)
      ? file.statements
          .filter((statement) => opensOutside(checker, statement, isLocalFile))
          .flatMap(moduleStatements)
      : [...file.statements],
  );
  for (let statement = pending.pop(); statement; statement = pending.pop()) {
    pending.push(...moduleStatements(statement));
    for (const name of declaredNames(statement)) {
      const symbol = checker.getSymbolAtLocation(name);
      if (symbol) visible.add(symbol);
    }
  }
  return [...visible];
}

/**
 * The declarations of the package that the signatures reach through their
 * parameter and answer types, transitively, each printed without comments.
 * `path` holds the symbols the surface entered to find the signatures, the
 * last one owning them; their declarations write the type arguments the
 * signatures were instantiated with. `visible` holds the
 * package's symbols outside text can name, from {@link outsideVisible}. A change inside a reached declaration,
 * such as a member's type, changes the functions that reach it.
 */
export function referencedDeclarations(
  checker: ts.TypeChecker,
  isLocalFile: (file: ts.SourceFile) => boolean,
  signatures: readonly ts.Signature[],
  path: readonly ts.Symbol[],
  visible: readonly ts.Symbol[],
): string[] {
  const walk = new DeclarationWalk(checker, isLocalFile);
  for (const symbol of visible) walk.reach(symbol);
  for (const symbol of path) walk.owner(symbol);
  for (const signature of signatures) walk.signature(signature);
  return walk.found.sort((left, right) => left.localeCompare(right));
}
