import type ts from "typescript";

import { typescript } from "./parser.ts";

/** The lint configs a repository writes, at any depth: `oxlint.config.*`, `.oxlintrc.json`, `.oxlintrc.jsonc` and `eslint.config.*`. */
export const LINT_CONFIG_FILE =
  /(?:^|\/)(?:(?:oxlint|eslint)\.config\.[cm]?[jt]s|\.oxlintrc\.jsonc?)$/u;

/**
 * A rule, or a category as `category:<name>`, that a lint config switches
 * off, to `allow` or to a warning for one entry of its `files` (`*` when the
 * block has none), at the line of the entry that weakens it.
 */
export interface ConfigRuleOff {
  rule: string;
  scope: string;
  line: number;
}

const WEAK_SEVERITIES = new Set(["off", "allow", "warn"]);
const WEAK_LEVELS = new Set(["0", "1"]);

type Declarations = ReadonlyMap<string, ts.Expression>;

function unwrapped(node: ts.Expression): ts.Expression {
  const compiler = typescript();
  let current = node;
  while (
    compiler.isParenthesizedExpression(current) ||
    compiler.isAsExpression(current) ||
    compiler.isSatisfiesExpression(current) ||
    compiler.isTypeAssertionExpression(current) ||
    compiler.isNonNullExpression(current)
  )
    current = current.expression;
  return current;
}

/** The expression `node` stands for: itself, or the initializer of the same-file variable it names. */
function resolved(
  node: ts.Expression,
  declarations: Declarations,
  seen = new Set<string>(),
): ts.Expression {
  const compiler = typescript();
  const value = unwrapped(node);
  if (!compiler.isIdentifier(value) || seen.has(value.text)) return value;
  const initializer = declarations.get(value.text);
  if (initializer === undefined) return value;
  seen.add(value.text);
  return resolved(initializer, declarations, seen);
}

function propertyName(name: ts.PropertyName): string | undefined {
  const compiler = typescript();
  return compiler.isIdentifier(name) ||
    compiler.isStringLiteralLike(name) ||
    compiler.isNumericLiteral(name)
    ? name.text
    : undefined;
}

function weakens(node: ts.Expression, declarations: Declarations): boolean {
  const compiler = typescript();
  const value = resolved(node, declarations);
  if (compiler.isStringLiteralLike(value))
    return WEAK_SEVERITIES.has(value.text);
  if (compiler.isNumericLiteral(value)) return WEAK_LEVELS.has(value.text);
  if (compiler.isArrayLiteralExpression(value)) {
    const [severity] = value.elements;
    return severity !== undefined && weakens(severity, declarations);
  }
  return false;
}

/** The entries of a rule map that weaken their rule, spreads of same-file maps included. */
function weakEntries(
  node: ts.Expression,
  declarations: Declarations,
  source: ts.SourceFile,
  depth = 0,
): { name: string; line: number }[] {
  const compiler = typescript();
  const value = resolved(node, declarations);
  if (!compiler.isObjectLiteralExpression(value) || depth > 8) return [];
  return value.properties.flatMap((property) => {
    if (compiler.isSpreadAssignment(property))
      return weakEntries(property.expression, declarations, source, depth + 1);
    if (!compiler.isPropertyAssignment(property)) return [];
    const name = propertyName(property.name);
    if (name === undefined || !weakens(property.initializer, declarations))
      return [];
    const start = property.getStart(source);
    return [
      { name, line: source.getLineAndCharacterOfPosition(start).line + 1 },
    ];
  });
}

/** The globs of a `files` value, each spread of a same-file array expanded; anything else counts as one scope. */
function globs(
  node: ts.Expression,
  declarations: Declarations,
  source: ts.SourceFile,
): string[] {
  const compiler = typescript();
  const value = resolved(node, declarations);
  if (compiler.isStringLiteralLike(value)) return [value.text];
  if (!compiler.isArrayLiteralExpression(value)) return [value.getText(source)];
  return value.elements.flatMap((element) =>
    globs(
      compiler.isSpreadElement(element) ? element.expression : element,
      declarations,
      source,
    ),
  );
}

function member(
  object: ts.ObjectLiteralExpression,
  key: string,
): ts.Expression | undefined {
  const compiler = typescript();
  for (const property of object.properties) {
    if (
      compiler.isPropertyAssignment(property) &&
      propertyName(property.name) === key
    )
      return property.initializer;
    if (
      compiler.isShorthandPropertyAssignment(property) &&
      property.name.text === key
    )
      return property.name;
  }
  return undefined;
}

function sourceOf(file: string, text: string): ts.SourceFile {
  const compiler = typescript();
  if (/\.jsonc?$/u.test(file)) return compiler.parseJsonText(file, text);
  return compiler.createSourceFile(
    file,
    text,
    compiler.ScriptTarget.Latest,
    false,
    /\.[cm]?ts$/u.test(file) ? compiler.ScriptKind.TS : compiler.ScriptKind.JS,
  );
}

function declarationsIn(source: ts.SourceFile): Declarations {
  const compiler = typescript();
  const declarations = new Map<string, ts.Expression>();
  const visit = (node: ts.Node) => {
    if (
      compiler.isVariableDeclaration(node) &&
      compiler.isIdentifier(node.name) &&
      node.initializer !== undefined
    )
      declarations.set(node.name.text, node.initializer);
    compiler.forEachChild(node, visit);
  };
  visit(source);
  return declarations;
}

/**
 * A glob of the config in `directory` as a path from the repository root;
 * the whole directory when `glob` is undefined. Root globs stay as written,
 * and a root block without `files` is `*`.
 */
function anchored(directory: string, glob?: string): string {
  if (glob === undefined) return directory === "" ? "*" : `${directory}/**`;
  if (directory === "") return glob;
  const negated = glob.startsWith("!");
  const path = (negated ? glob.slice(1) : glob).replace(/^(?:\.\/|\/)+/u, "");
  return `${negated ? "!" : ""}${directory}/${path}`;
}

/**
 * Each rule and category a lint config file switches off, to `allow` or to
 * a warning: in every object's `rules` and `categories`, and in the argument
 * of an ESLint composer's `overrideRules`, once per glob of the object's
 * `files`, each glob anchored at the config's directory so a scope never
 * reaches past it. Rule maps and globs held in same-file variables or spread from
 * them count where they are used; configs the pack's presets return are
 * not in the file, so they never count.
 */
export function configRuleOffs(file: string, text: string): ConfigRuleOff[] {
  if (!LINT_CONFIG_FILE.test(file)) return [];
  const compiler = typescript();
  const source = sourceOf(file, text);
  const declarations = declarationsIn(source);
  const directory = file.includes("/")
    ? file.slice(0, file.lastIndexOf("/"))
    : "";
  const whole = [anchored(directory)];
  const found: ConfigRuleOff[] = [];
  const add = (
    map: ts.Expression | undefined,
    scopes: string[],
    prefix: string,
  ) => {
    if (map === undefined) return;
    for (const { name, line } of weakEntries(map, declarations, source))
      for (const scope of scopes)
        found.push({ rule: `${prefix}${name}`, scope, line });
  };
  const visit = (node: ts.Node) => {
    if (compiler.isObjectLiteralExpression(node)) {
      const files = member(node, "files");
      const scopes =
        files === undefined
          ? whole
          : globs(files, declarations, source).map((glob) =>
              anchored(directory, glob),
            );
      add(member(node, "rules"), scopes, "");
      add(member(node, "categories"), scopes, "category:");
    }
    if (
      compiler.isCallExpression(node) &&
      compiler.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "overrideRules"
    )
      add(node.arguments[0], whole, "");
    compiler.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
