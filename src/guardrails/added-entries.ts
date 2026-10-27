import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import type ts from "typescript";

/** A published entry's output file, relative to its revision's output root, and the package subpath it publishes. */
export interface PublishedEntry {
  path: string;
  directory: string;
  subpath: string;
}

/** The `--allow-added` state shared by both proof halves: globs, `@internal` verdicts and what was let through. */
export interface AddedPolicy {
  globs: readonly string[];
  verdicts: Map<string, string | undefined>;
  allowed: Map<string, { directory: string; subpath: string }>;
  problems: Set<string>;
}

export function createAddedPolicy(globs: readonly string[]): AddedPolicy {
  return {
    globs,
    verdicts: new Map(),
    allowed: new Map(),
    problems: new Set(),
  };
}

function entryKey(directory: string, subpath: string): string {
  return `${directory}\0${subpath}`;
}

export function allowedByGlob(policy: AddedPolicy, subpath: string): boolean {
  return policy.globs.some((glob) => matchesGlob(subpath, glob));
}

/** Substitutes each export star in order with its capture, as the published target pattern did. */
export function fillStars(
  pattern: string,
  captures: readonly string[],
  format: (capture: string) => string = (capture) => capture,
): string {
  let index = 0;
  return pattern.replaceAll("*", () =>
    format(captures[index++] ?? captures[0] ?? ""),
  );
}

const INTERNAL_TAG = /@internal\b/u;
const MODULE_TAG = /@(?:packageDocumentation|module|fileoverview)\b/u;

function exportedLocalNames(
  compiler: typeof ts,
  source: ts.SourceFile,
): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (
      compiler.isExportDeclaration(statement) &&
      statement.moduleSpecifier === undefined &&
      statement.exportClause !== undefined &&
      compiler.isNamedExports(statement.exportClause)
    )
      for (const element of statement.exportClause.elements)
        names.add((element.propertyName ?? element.name).text);
    if (
      compiler.isExportAssignment(statement) &&
      compiler.isIdentifier(statement.expression)
    )
      names.add(statement.expression.text);
  }
  return names;
}

function declaredNames(compiler: typeof ts, statement: ts.Statement): string[] {
  if (compiler.isVariableStatement(statement))
    return statement.declarationList.declarations.flatMap((declaration) =>
      compiler.isIdentifier(declaration.name) ? [declaration.name.text] : [],
    );
  if (
    (compiler.isFunctionDeclaration(statement) ||
      compiler.isClassDeclaration(statement) ||
      compiler.isInterfaceDeclaration(statement) ||
      compiler.isTypeAliasDeclaration(statement) ||
      compiler.isEnumDeclaration(statement) ||
      compiler.isModuleDeclaration(statement)) &&
    statement.name !== undefined &&
    compiler.isIdentifier(statement.name)
  )
    return [statement.name.text];
  return [];
}

function isExportedDeclaration(
  compiler: typeof ts,
  statement: ts.Statement,
  locals: ReadonlySet<string>,
): boolean {
  if (compiler.isExportAssignment(statement))
    return !compiler.isIdentifier(statement.expression);
  const modifiers = compiler.canHaveModifiers(statement)
    ? compiler.getModifiers(statement)
    : undefined;
  if (
    modifiers?.some(
      (modifier) => modifier.kind === compiler.SyntaxKind.ExportKeyword,
    )
  )
    return true;
  return declaredNames(compiler, statement).some((name) => locals.has(name));
}

function hasInternalTag(compiler: typeof ts, statement: ts.Statement): boolean {
  return compiler
    .getJSDocTags(statement)
    .some((tag) => tag.tagName.text === "internal");
}

/** Whether a module's text carries `@internal` on the module (with `@packageDocumentation`, `@module` or `@fileoverview`) or on every exported declaration. */
function isInternalModule(compiler: typeof ts, text: string): boolean {
  const source = compiler.createSourceFile(
    "module.ts",
    text,
    compiler.ScriptTarget.Latest,
    true,
  );
  const header = (compiler.getLeadingCommentRanges(text, 0) ?? []).map(
    (range) => text.slice(range.pos, range.end),
  );
  if (
    header.some(
      (comment) =>
        comment.startsWith("/**") &&
        INTERNAL_TAG.test(comment) &&
        MODULE_TAG.test(comment),
    )
  )
    return true;
  const locals = exportedLocalNames(compiler, source);
  const exported = source.statements.filter((statement) =>
    isExportedDeclaration(compiler, statement, locals),
  );
  return (
    exported.length > 0 &&
    exported.every((statement) => hasInternalTag(compiler, statement))
  );
}

/** Records why an allowed added entry is not internal, or `undefined` when its module is. */
export function recordVerdict(
  policy: AddedPolicy,
  compiler: typeof ts,
  entry: { directory: string; subpath: string; module: string; label: string },
): void {
  const internal = isInternalModule(
    compiler,
    readFileSync(entry.module, "utf8"),
  );
  policy.verdicts.set(
    entryKey(entry.directory, entry.subpath),
    internal
      ? undefined
      : `${entry.label}: added entry ./${entry.subpath} is allowed by --allow-added but is not marked @internal. Add a leading "/** @internal @packageDocumentation */" comment to the file, or tag every exported declaration with "/** @internal */".`,
  );
}

/** Lets matching, `@internal` additions through by removing them from the head output; returns how many files were removed. */
export function applyAllowance(
  policy: AddedPolicy,
  base: readonly PublishedEntry[],
  head: readonly PublishedEntry[],
  remove: (path: string) => void,
): number {
  const existing = new Set(base.map(({ path }) => path));
  let removed = 0;
  for (const entry of head) {
    if (existing.has(entry.path) || !allowedByGlob(policy, entry.subpath))
      continue;
    const key = entryKey(entry.directory, entry.subpath);
    const problem = policy.verdicts.has(key)
      ? policy.verdicts.get(key)
      : `${entry.directory}: added entry ./${entry.subpath} has no emitted declaration, so @internal cannot be verified.`;
    if (problem !== undefined) {
      policy.problems.add(problem);
      continue;
    }
    remove(entry.path);
    removed += 1;
    policy.allowed.set(key, {
      directory: entry.directory,
      subpath: entry.subpath,
    });
  }
  return removed;
}

/** The "Added (allowed)" list with its count, or the problems that kept additions from passing. */
export function describeAllowance(policy: AddedPolicy): string {
  const lines = [...policy.allowed.values()]
    .map(({ directory, subpath }) => `  ${directory}: ./${subpath}\n`)
    .sort();
  return `Added (allowed): ${lines.length}\n${lines.join("")}${[
    ...policy.problems,
  ]
    .map((problem) => `Not internal: ${problem}\n`)
    .join("")}`;
}
