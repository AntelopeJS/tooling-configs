import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import type ts from "typescript";

type Compiler = typeof ts;

/** Where the generated Vite config takes the dms-frontend auto-imports from, relative to the `@antelopejs/dms-frontend` package. */
const FRONTEND_MODULE = join(
  "node_modules",
  "@antelopejs",
  "dms-frontend",
  "templates",
  "vue",
  "frontend-module.ts",
);

const NAME_SEPARATOR = /[-_.]/u;

const SOURCE_EXTENSION = /(?:\.d)?\.[cm]?[jt]sx?$/u;

/** An auto-import as unimport injects it: the binding a file sees, the export it reads, and the module it reads it from. */
interface AutoImport {
  name: string;
  imported: string;
  specifier: string;
}

/** The name unimport gives a default export: the file name, or its directory's for an index file, in camel case when it has a separator. */
function defaultExportName(file: string): string {
  const own = parse(file).name;
  const name = own === "index" ? parse(dirname(file)).name : own;
  if (!NAME_SEPARATOR.test(name)) return name;
  return name
    .split(/[-_.]+/u)
    .filter(Boolean)
    .map((word, index) =>
      index === 0
        ? `${word.charAt(0).toLowerCase()}${word.slice(1)}`
        : `${word.charAt(0).toUpperCase()}${word.slice(1)}`,
    )
    .join("");
}

function frontendModule(moduleRoot: string): string | undefined {
  for (let directory = moduleRoot; ; directory = dirname(directory)) {
    if (existsSync(join(directory, FRONTEND_MODULE)))
      return join(directory, FRONTEND_MODULE);
    if (dirname(directory) === directory) return undefined;
  }
}

/** The modules besides the scanned files whose exports the frontend build auto-imports: dms-frontend's `frontend-module.ts` and the `vue` preset, each with the specifier a scanned file imports it by. */
export function presetModules(
  compiler: Compiler,
  moduleRoot: string,
  options: ts.CompilerOptions,
): { file: string; specifier: string }[] {
  const presets: { file: string; specifier: string }[] = [];
  const frontend = frontendModule(moduleRoot);
  if (frontend !== undefined)
    presets.push({
      file: frontend,
      specifier: frontend.replace(SOURCE_EXTENSION, ""),
    });
  const vue = compiler.resolveModuleName(
    "vue",
    join(moduleRoot, "auto-imports.ts"),
    options,
    compiler.sys,
  ).resolvedModule?.resolvedFileName;
  if (vue !== undefined) presets.push({ file: vue, specifier: "vue" });
  return presets;
}

/** The names a file exports, as unimport names them. */
export function exportedNames(
  checker: ts.TypeChecker,
  source: ts.SourceFile,
): { name: string; symbol: ts.Symbol }[] {
  const owner = checker.getSymbolAtLocation(source);
  if (owner === undefined) return [];
  return checker.getExportsOfModule(owner).map((symbol) => ({
    name:
      symbol.name === "default"
        ? defaultExportName(source.fileName)
        : symbol.name,
    symbol,
  }));
}

function bindingNames(compiler: Compiler, name: ts.BindingName): string[] {
  if (compiler.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    compiler.isOmittedExpression(element)
      ? []
      : bindingNames(compiler, element.name),
  );
}

function importedNames(
  compiler: Compiler,
  statement: ts.ImportDeclaration,
): string[] {
  const clause = statement.importClause;
  const bindings = clause?.namedBindings;
  return [
    ...(clause?.name === undefined ? [] : [clause.name.text]),
    ...(bindings !== undefined && compiler.isNamespaceImport(bindings)
      ? [bindings.name.text]
      : []),
    ...(bindings !== undefined && compiler.isNamedImports(bindings)
      ? bindings.elements.map((element) => element.name.text)
      : []),
  ];
}

function declaredName(
  compiler: Compiler,
  statement: ts.Statement,
): string | undefined {
  if (
    !(
      compiler.isFunctionDeclaration(statement) ||
      compiler.isClassDeclaration(statement) ||
      compiler.isInterfaceDeclaration(statement) ||
      compiler.isTypeAliasDeclaration(statement) ||
      compiler.isEnumDeclaration(statement) ||
      compiler.isModuleDeclaration(statement) ||
      compiler.isImportEqualsDeclaration(statement)
    ) ||
    statement.name === undefined ||
    !compiler.isIdentifier(statement.name)
  )
    return undefined;
  return statement.name.text;
}

/** The names a file binds at its top level, which an auto-import never shadows. */
function localNames(compiler: Compiler, source: ts.SourceFile): Set<string> {
  return new Set(
    source.statements.flatMap((statement) => {
      if (compiler.isImportDeclaration(statement))
        return importedNames(compiler, statement);
      if (compiler.isVariableStatement(statement))
        return statement.declarationList.declarations.flatMap((declaration) =>
          bindingNames(compiler, declaration.name),
        );
      const name = declaredName(compiler, statement);
      return name === undefined ? [] : [name];
    }),
  );
}

/** Every auto-import a scanned file may use without importing it: dms-frontend's composables, then vue's exports, then the module's own scanned exports; the first module to offer a name keeps it. */
export function autoImports(
  checker: ts.TypeChecker,
  sources: readonly { source: ts.SourceFile; specifier: string }[],
): AutoImport[] {
  const imports = new Map<string, AutoImport>();
  for (const { source, specifier } of sources)
    for (const { name, symbol } of exportedNames(checker, source))
      if (!imports.has(name))
        imports.set(name, { name, imported: symbol.name, specifier });
  return [...imports.values()];
}

/** The specifier a scanned file is imported by: its path without the source extension. */
export function sourceSpecifier(file: string): string {
  return file.replace(SOURCE_EXTENSION, "");
}

/**
 * A compiler host that prepends to each scanned module the imports unimport
 * would inject, so names a file uses without importing them type as they do
 * in the frontend build instead of as `any`. Only names the file does not bind
 * itself are injected, and scripts and declaration files are left as they are.
 */
export function injectingHost(
  compiler: Compiler,
  options: ts.CompilerOptions,
  scanned: ReadonlyMap<string, ts.SourceFile>,
  imports: readonly AutoImport[],
): ts.CompilerHost {
  const host = compiler.createCompilerHost(options, true);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, language, onError, create) => {
    const source = scanned.get(fileName);
    if (
      source === undefined ||
      source.isDeclarationFile ||
      !compiler.isExternalModule(source)
    )
      return read(fileName, language, onError, create);
    const own = localNames(compiler, source);
    const bySpecifier = new Map<string, string[]>();
    for (const { name, imported, specifier } of imports) {
      if (own.has(name) || specifier === sourceSpecifier(fileName)) continue;
      const list = bySpecifier.get(specifier) ?? [];
      list.push(imported === name ? name : `${imported} as ${name}`);
      bySpecifier.set(specifier, list);
    }
    const prefix = [...bySpecifier]
      .map(
        ([specifier, names]) =>
          `import { ${names.join(", ")} } from ${JSON.stringify(specifier)};\n`,
      )
      .join("");
    return compiler.createSourceFile(
      fileName,
      `${prefix}${source.text}`,
      language,
      true,
    );
  };
  return host;
}
