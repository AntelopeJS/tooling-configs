import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, matchesGlob, relative, resolve, sep } from "node:path";
import type ts from "typescript";

import { trackedManifests } from "./revisions.ts";

export type ExportTarget =
  | string
  | null
  | ExportTarget[]
  | { [condition: string]: ExportTarget };

export interface ProofManifest {
  name?: string;
  private?: boolean;
  exports?: ExportTarget;
  main?: string;
  types?: string;
  typings?: string;
  typesVersions?: Record<string, Record<string, string[]>>;
}

/** A proof analyses only packages that publish something: not private, and declaring at least one of `exports`, `main`, `types`, `typings` or `typesVersions`. */
function unpublishedReason(manifest: ProofManifest): string | undefined {
  if (manifest.private === true) return "private";
  const publishes = [
    manifest.exports,
    manifest.main,
    manifest.types,
    manifest.typings,
    manifest.typesVersions,
  ].some((field) => field != null);
  return publishes ? undefined : "no exports, main or types";
}

function trackedPackages(root: string) {
  return trackedManifests(root).flatMap((file) => {
    const directory = dirname(file);
    if (!existsSync(join(root, directory, "tsconfig.json"))) return [];
    /* SAFETY: tracked package manifests provide the standard optional publication fields. */
    const manifest = JSON.parse(
      readFileSync(join(root, file), "utf8"),
    ) as ProofManifest;
    return [{ directory, manifest }];
  });
}

export function packagesAt(root: string, publishedOnly: boolean) {
  return trackedPackages(root).filter(
    ({ manifest }) =>
      !publishedOnly || unpublishedReason(manifest) === undefined,
  );
}

/** The packages a published-only proof leaves out, each with the reason, so a skip is reported rather than silent. */
export function unpublishedAt(root: string) {
  return trackedPackages(root).flatMap(({ directory, manifest }) => {
    const reason = unpublishedReason(manifest);
    return reason === undefined ? [] : [{ directory, reason }];
  });
}

/** A TypeScript installation and the directory of its package. */
interface PackageCompiler {
  compiler: typeof ts;
  root: string;
}

function packageRoot(file: string): string {
  let directory = dirname(file);
  while (!existsSync(join(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory) return dirname(file);
    directory = parent;
  }
  return directory;
}

/** Loads the compiler a package builds with, including a package-local installation in a workspace, falling back to the one `dts-bundle-generator` brings. A TypeScript without the programmatic API (7 and later) is an error rather than a crash. */
function loadTypeScript(directory: string): PackageCompiler {
  const own = createRequire(import.meta.url);
  let file: string;
  try {
    file = createRequire(join(directory, "package.json")).resolve("typescript");
  } catch {
    file = createRequire(own.resolve("dts-bundle-generator")).resolve(
      "typescript",
    );
  }
  /* SAFETY: a resolved typescript package implements the compiler API unless the check below rejects it. */
  const compiler = createRequire(file)("typescript") as typeof ts;
  const root = packageRoot(file);
  if (compiler.sys === undefined || !("createProgram" in compiler))
    throw new Error(
      `TypeScript ${compiler.version} at ${root} has no programmatic compiler API (sys, createProgram), so this package cannot be analysed. Build it with a TypeScript that has one, or mark the package private.`,
    );
  return { compiler, root };
}

const TEST_SOURCE_GLOBS = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "test/**",
  "tests/**",
];

export function isTestSource(root: string, file: string): boolean {
  const path = relative(root, file).split("\\").join("/");
  return TEST_SOURCE_GLOBS.some((pattern) => matchesGlob(path, pattern));
}

function failDiagnostics(
  compiler: typeof ts,
  diagnostics: readonly ts.Diagnostic[],
): void {
  const errors = diagnostics.filter(
    (item) => item.category === compiler.DiagnosticCategory.Error,
  );
  if (errors.length)
    throw new Error(
      compiler.formatDiagnostics(errors, {
        getCanonicalFileName: (file) => file,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => "\n",
      }),
    );
}

/** Declaration inputs are part of the local closure but TypeScript does not emit copies of them. */
function copyDeclarations(
  program: ts.Program,
  directory: string,
  output: string,
): string[] {
  const sources = program
    .getSourceFiles()
    .filter(
      (source) =>
        !program.isSourceFileDefaultLibrary(source) &&
        !program.isSourceFileFromExternalLibrary(source) &&
        !relative(directory, source.fileName).startsWith(`..${sep}`) &&
        !isTestSource(directory, source.fileName),
    );
  const authored = sources.filter((source) => !source.isDeclarationFile);
  let root = dirname(
    (authored[0] ?? sources[0])?.fileName ?? join(directory, "index.ts"),
  );
  for (const source of authored.length ? authored : sources)
    while (relative(root, source.fileName).startsWith(`..${sep}`))
      root = dirname(root);
  root = program.getCompilerOptions().rootDir ?? root;
  const files: string[] = [];
  for (const source of sources) {
    if (!source.isDeclarationFile) continue;
    const path = relative(root, source.fileName);
    if (path.startsWith(`..${sep}`)) continue;
    const target = join(output, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source.text);
    files.push(target);
  }
  return files;
}

function parseConfig(directory: string) {
  const { compiler, root } = loadTypeScript(directory);
  const config = compiler.readConfigFile(
    join(directory, "tsconfig.json"),
    compiler.sys.readFile,
  );
  if (config.error) failDiagnostics(compiler, [config.error]);
  const parsed = compiler.parseJsonConfigFileContent(
    config.config,
    compiler.sys,
    directory,
  );
  failDiagnostics(compiler, parsed.errors);
  return { compiler, root, parsed };
}

/** The configured `outDir`, the root under which the declaration half already judges a built path as test output. */
export function outputRoot(directory: string): string {
  return resolve(
    directory,
    parseConfig(directory).parsed.options.outDir ?? ".",
  );
}

/** Emits with the package's compiler and config; test roots and outputs never enter either proof. `modules` maps each emitted file to its source module. */
export function emitPackage(
  directory: string,
  output: string,
  declarations: boolean,
) {
  const { compiler, root, parsed } = parseConfig(directory);
  const options: ts.CompilerOptions = {
    ...parsed.options,
    rootDir:
      parsed.options.rootDir ?? (parsed.options.outDir ? undefined : directory),
    outDir: output,
    declarationDir: declarations ? output : undefined,
    declaration: declarations,
    emitDeclarationOnly: declarations,
    removeComments: true,
    declarationMap: false,
    sourceMap: false,
    inlineSourceMap: false,
    noEmit: false,
    noEmitOnError: false,
    composite: false,
    incremental: false,
    tsBuildInfoFile: undefined,
    outFile: undefined,
    allowImportingTsExtensions: declarations
      ? parsed.options.allowImportingTsExtensions
      : false,
  };
  const program = compiler.createProgram({
    rootNames: parsed.fileNames.filter(
      (file) => !isTestSource(directory, file),
    ),
    options,
    projectReferences: parsed.projectReferences,
  });
  if (declarations)
    failDiagnostics(compiler, compiler.getPreEmitDiagnostics(program));
  const files: string[] = [];
  const modules = new Map<string, string>();
  const result = program.emit(
    undefined,
    (file, text, _bom, _onError, sources) => {
      if (sources?.some((source) => isTestSource(directory, source.fileName)))
        return;
      if (
        declarations ? !/\.d\.[cm]?ts$/.test(file) : !/\.[cm]?jsx?$/.test(file)
      )
        return;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
      files.push(file);
      if (sources?.[0] !== undefined)
        modules.set(resolve(file), sources[0].fileName);
    },
  );
  if (declarations) failDiagnostics(compiler, result.diagnostics);
  if (declarations) files.push(...copyDeclarations(program, directory, output));
  return {
    compiler,
    compilerRoot: root,
    files,
    modules,
    options: parsed.options,
  };
}
