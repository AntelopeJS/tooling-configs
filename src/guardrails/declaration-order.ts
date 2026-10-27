import type ts from "typescript";

type Compiler = typeof ts;
type Member = ts.TypeElement | ts.ClassElement;

const CALL = 0;
const CONSTRUCT = 1;
const INDEX = 2;
const CONSTRUCTOR = 3;
const INSTANCE = 4;
const STATIC = 5;

interface MemberKey {
  rank: number;
  name: string;
}

function nameText(
  compiler: Compiler,
  name: ts.PropertyName,
  source: ts.SourceFile,
): string {
  return compiler.isIdentifier(name) ||
    compiler.isStringLiteral(name) ||
    compiler.isNumericLiteral(name) ||
    compiler.isPrivateIdentifier(name)
    ? name.text
    : name.getText(source);
}

function memberKey(
  compiler: Compiler,
  member: Member,
  source: ts.SourceFile,
): MemberKey {
  if (compiler.isCallSignatureDeclaration(member))
    return { rank: CALL, name: "" };
  if (compiler.isConstructSignatureDeclaration(member))
    return { rank: CONSTRUCT, name: "" };
  if (compiler.isConstructorDeclaration(member))
    return { rank: CONSTRUCTOR, name: "" };
  if (compiler.isIndexSignatureDeclaration(member))
    return {
      rank: INDEX,
      name: member.parameters[0]?.type?.getText(source) ?? "",
    };
  const isStatic =
    compiler.canHaveModifiers(member) &&
    (compiler.getModifiers(member) ?? []).some(
      ({ kind }) => kind === compiler.SyntaxKind.StaticKeyword,
    );
  return {
    rank: isStatic ? STATIC : INSTANCE,
    name:
      member.name === undefined ? "" : nameText(compiler, member.name, source),
  };
}

function compareKeys(a: MemberKey, b: MemberKey): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

/** Orders `visited` by keys read from `original`, the same members before their children were rewritten. The sort is stable, so overloads of one name, call signatures and construct signatures keep their written order. */
function sortMembers<T extends Member>(
  compiler: Compiler,
  visited: ts.NodeArray<T>,
  original: ts.NodeArray<Member>,
  source: ts.SourceFile,
): ts.NodeArray<T> {
  const keyed = visited.map((member, index) => ({
    member,
    key: memberKey(compiler, original[index], source),
  }));
  keyed.sort((a, b) => compareKeys(a.key, b.key));
  return compiler.factory.createNodeArray(keyed.map(({ member }) => member));
}

/** Rewrites every object type literal, interface and class in `file`, whose nodes were parsed from `source`, so its members appear in a canonical order. Member order does not change a type, so two declaration texts that differ only in it print identically. Tuple elements, parameters, overloads of one name, enum members, union and intersection constituents and statement bodies of namespaces keep the order they were written in. */
function sortDeclarationMembers(
  compiler: Compiler,
  file: ts.SourceFile,
  source: ts.SourceFile,
): ts.SourceFile {
  const { factory } = compiler;
  const result = compiler.transform(file, [
    (context) => {
      const visit = (node: ts.Node): ts.Node => {
        const visited = compiler.visitEachChild(node, visit, context);
        if (
          compiler.isTypeLiteralNode(node) &&
          compiler.isTypeLiteralNode(visited)
        )
          return factory.updateTypeLiteralNode(
            visited,
            sortMembers(compiler, visited.members, node.members, source),
          );
        if (
          compiler.isInterfaceDeclaration(node) &&
          compiler.isInterfaceDeclaration(visited)
        )
          return factory.updateInterfaceDeclaration(
            visited,
            visited.modifiers,
            visited.name,
            visited.typeParameters,
            visited.heritageClauses,
            sortMembers(compiler, visited.members, node.members, source),
          );
        if (
          compiler.isClassDeclaration(node) &&
          compiler.isClassDeclaration(visited)
        )
          return factory.updateClassDeclaration(
            visited,
            visited.modifiers,
            visited.name,
            visited.typeParameters,
            visited.heritageClauses,
            sortMembers(compiler, visited.members, node.members, source),
          );
        return visited;
      };
      return (root) =>
        /* SAFETY: visiting a source file returns a source file. */
        visit(root) as ts.SourceFile;
    },
  ]);
  const [transformed] = result.transformed;
  result.dispose();
  return transformed;
}

function statementName(
  compiler: typeof ts,
  statement: ts.Statement,
  source: ts.SourceFile,
): string {
  if (compiler.isVariableStatement(statement))
    return (
      statement.declarationList.declarations[0]?.name.getText(source) ?? ""
    );
  if (
    compiler.isFunctionDeclaration(statement) ||
    compiler.isClassDeclaration(statement) ||
    compiler.isInterfaceDeclaration(statement) ||
    compiler.isTypeAliasDeclaration(statement) ||
    compiler.isEnumDeclaration(statement) ||
    compiler.isModuleDeclaration(statement) ||
    compiler.isImportEqualsDeclaration(statement)
  )
    return statement.name?.getText(source) ?? "default";
  return statement.getText(source);
}

/** Prints a bundle in canonical form: top-level statements by name and object members in a fixed order. */
export function normalizeBundle(compiler: typeof ts, text: string): string {
  const source = compiler.createSourceFile(
    "bundle.d.ts",
    text,
    compiler.ScriptTarget.Latest,
    true,
  );
  const statements = [...source.statements].sort((a, b) =>
    statementName(compiler, a, source).localeCompare(
      statementName(compiler, b, source),
    ),
  );
  const normalized = sortDeclarationMembers(
    compiler,
    compiler.factory.updateSourceFile(source, statements),
    source,
  );
  return compiler
    .createPrinter({
      removeComments: true,
      newLine: compiler.NewLineKind.LineFeed,
    })
    .printFile(normalized);
}
