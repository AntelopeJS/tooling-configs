import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, matchesGlob, relative, resolve, sep } from "node:path";
import type ts from "typescript";

import {
  declaresTypeScript,
  describePackage,
  repositoryDirectory,
} from "./declared-typescript.ts";
import { workspaceDirectories, workspacePatterns } from "./docs-compat.ts";
import { trackedManifests } from "./files.ts";

export type ExportTarget =
  | string
  | null
  | ExportTarget[]
  | { [condition: string]: ExportTarget };

/** A package `exports` leaf: a path rather than a fallback list or a condition map. */
export function isExportPath(
  target: ExportTarget | undefined,
): target is string {
  return typeof target === "string";
}

export interface ProofManifest {
  name?: string;
  private?: boolean;
  exports?: ExportTarget;
  main?: string;
  types?: string;
  typings?: string;
  typesVersions?: Record<string, Record<string, string[]>>;
}

/** A proof analyses only packages that publish something: in the repository's workspace, not private, and declaring at least one of `exports`, `main`, `types`, `typings` or `typesVersions`. */
function unpublishedReason(
  manifest: ProofManifest,
  member: boolean,
): string | undefined {
  if (!member) return "not a workspace package";
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

/** Whether the package at `directory` belongs to the workspace at `root`: always when `root` declares none, else when it is `root` or a listed member. */
function workspaceMember(root: string): (directory: string) => boolean {
  if (
    !workspacePatterns(root).length &&
    !existsSync(join(root, "pnpm-workspace.yaml"))
  )
    return () => true;
  const members = new Set(workspaceDirectories(root));
  return (directory) => directory === "." || members.has(directory);
}

function trackedPackages(root: string) {
  const member = workspaceMember(root);
  return trackedManifests(root).flatMap((file) => {
    const directory = dirname(file);
    if (!existsSync(join(root, directory, "tsconfig.json"))) return [];
    /* SAFETY: tracked package manifests provide the standard optional publication fields. */
    const manifest = JSON.parse(
      readFileSync(join(root, file), "utf8"),
    ) as ProofManifest;
    return [{ directory, manifest, member: member(directory) }];
  });
}

export function packagesAt(root: string, publishedOnly: boolean) {
  return trackedPackages(root).filter(
    ({ manifest, member }) =>
      !publishedOnly || unpublishedReason(manifest, member) === undefined,
  );
}

/** The packages a published-only proof leaves out, each with the reason, so a skip is reported rather than silent. */
export function unpublishedAt(root: string) {
  return trackedPackages(root).flatMap(({ directory, manifest, member }) => {
    const reason = unpublishedReason(manifest, member);
    return reason === undefined ? [] : [{ directory, reason }];
  });
}

/** A TypeScript installation and the directory of its package; `notice` says the pack's was used, because the package declares none or, for a JavaScript-only emit, because its own has no compiler API. */
interface PackageCompiler {
  compiler: typeof ts;
  root: string;
  notice?: string;
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

function resolveTypeScript(directory: string) {
  try {
    return {
      file: createRequire(join(directory, "package.json")).resolve(
        "typescript",
      ),
      fallback: false,
    };
  } catch (error) {
    if (declaresTypeScript(directory))
      throw new Error(
        `${describePackage(directory)} declares typescript but it cannot be resolved from the package directory, so the compiler it builds with is not available. Install dependencies (run pnpm install) and retry.`,
        { cause: error },
      );
    return { file: packTypeScript(), fallback: true };
  }
}

/** The TypeScript `dts-bundle-generator` brings, which the pack falls back to. */
function packTypeScript(): string {
  return createRequire(
    createRequire(import.meta.url).resolve("dts-bundle-generator"),
  ).resolve("typescript");
}

/** Loads the TypeScript at `file`; one without the programmatic API (7 and later) yields only its `version`, so the caller reports it rather than crashing. */
function requireTypeScript(file: string) {
  /* SAFETY: a resolved typescript package implements the compiler API unless the check below rejects it. */
  const compiler = createRequire(file)("typescript") as typeof ts;
  const root = packageRoot(file);
  if (compiler.sys === undefined || !("createProgram" in compiler))
    return { root, version: compiler.version };
  return { root, compiler };
}

/** Loads the compiler a package builds with, including a package-local installation in a workspace. A package that declares `typescript` (itself or through its workspace root) but cannot resolve it is an error; only a package that declares none falls back to the one `dts-bundle-generator` brings, with a `notice`. A TypeScript without the programmatic API (7 and later) is an error, unless `javascriptOnly` says the caller only strips comments and emits JavaScript, so the pack's TypeScript emits both revisions instead, with a `notice`. */
export function loadTypeScript(
  directory: string,
  javascriptOnly = false,
): PackageCompiler {
  const { file, fallback } = resolveTypeScript(directory);
  const loaded = requireTypeScript(file);
  if (loaded.compiler !== undefined)
    return {
      compiler: loaded.compiler,
      root: loaded.root,
      notice: fallback
        ? `${repositoryDirectory(directory)}: declares no typescript; using the pack's TypeScript ${loaded.compiler.version}\n`
        : undefined,
    };
  const pack =
    javascriptOnly && !fallback ? requireTypeScript(packTypeScript()) : loaded;
  if (pack.compiler === undefined)
    throw new Error(
      `TypeScript ${loaded.version} at ${loaded.root} has no programmatic compiler API (sys, createProgram), so this package cannot be analysed. Build it with a TypeScript that has one, or mark the package private.`,
    );
  return {
    compiler: pack.compiler,
    root: pack.root,
    notice: `${repositoryDirectory(directory)}: TypeScript ${loaded.version} has no programmatic compiler API; emitting JavaScript with the pack's TypeScript ${pack.compiler.version}\n`,
  };
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

function formatErrors(
  compiler: typeof ts,
  diagnostics: readonly ts.Diagnostic[],
): string {
  return compiler.formatDiagnostics(
    diagnostics.filter(
      (item) => item.category === compiler.DiagnosticCategory.Error,
    ),
    {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    },
  );
}

function failDiagnostics(
  compiler: typeof ts,
  diagnostics: readonly ts.Diagnostic[],
): void {
  const errors = formatErrors(compiler, diagnostics);
  if (errors) throw new Error(errors);
}

/** Declaration inputs are part of the local closure but TypeScript does not emit copies of them. */
function copyDeclarations(
  program: ts.Program,
  directory: string,
  output: string,
  modules: Map<string, string>,
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
    modules.set(resolve(target), source.fileName);
  }
  return files;
}

/** TS18002: `"files": []` without references. */
const EMPTY_FILES_LIST = 18002;

function readConfig(directory: string, javascriptOnly = false) {
  const { compiler, root, notice } = loadTypeScript(directory, javascriptOnly);
  const file = join(directory, "tsconfig.json");
  const config = compiler.readConfigFile(file, compiler.sys.readFile);
  if (config.error) failDiagnostics(compiler, [config.error]);
  const parsed = compiler.parseJsonConfigFileContent(
    config.config,
    compiler.sys,
    directory,
    undefined,
    file,
  );
  return { compiler, root, notice, parsed };
}

/** Parses `tsconfig.json` as `tsc -p` would from the package directory, failing on any configuration error. */
function parseConfig(directory: string, javascriptOnly = false) {
  const config = readConfig(directory, javascriptOnly);
  failDiagnostics(config.compiler, config.parsed.errors);
  return config;
}

/** Whether `tsconfig.json` has an empty `files` list, references nothing, and so parses to no inputs; read for a JavaScript-only emit, so a compiler without the API falls back as `emitPackage` does. */
export function listsNoFiles(directory: string): boolean {
  const { parsed } = readConfig(directory, true);
  return (
    parsed.fileNames.length === 0 &&
    parsed.errors.some((error) => error.code === EMPTY_FILES_LIST)
  );
}

/** The absolute paths of the configs `tsconfig.json` extends, directly or through another config; read for a JavaScript-only emit, as `listsNoFiles` is. */
export function extendedConfigs(directory: string): string[] {
  const { compiler } = loadTypeScript(directory, true);
  const file = join(directory, "tsconfig.json");
  const source = compiler.readJsonConfigFile(file, compiler.sys.readFile);
  compiler.parseJsonSourceFileConfigFileContent(
    source,
    compiler.sys,
    directory,
    undefined,
    file,
  );
  return (source.extendedSourceFiles ?? []).map((path) => resolve(path));
}

/** TypeScript records on parsed options, untyped, the directory of the config that declares `paths`, which its targets resolve against when no `baseUrl` is set. */
function isRecordedDirectory(
  value: ts.CompilerOptions[string],
): value is string {
  return typeof value === "string";
}

/** The configured `paths`, each target made absolute against `baseUrl`, else the directory of the config that declares `paths`. */
function absolutePaths(
  options: ts.CompilerOptions,
): Record<string, string[]> | undefined {
  const { paths, baseUrl, pathsBasePath } = options;
  if (paths === undefined || !isRecordedDirectory(pathsBasePath))
    return undefined;
  const base = baseUrl ?? pathsBasePath;
  return Object.fromEntries(
    Object.entries(paths).map(([key, targets]) => [
      key,
      targets.map((target) => resolve(base, target)),
    ]),
  );
}

/** The configured `outDir`, the root under which the declaration half already judges a built path as test output. */
export function outputRoot(directory: string): string {
  return resolve(
    directory,
    parseConfig(directory).parsed.options.outDir ?? ".",
  );
}

/** The root TypeScript lays its emit out under: `rootDir`, else the common directory of every authored source in `program`, wherever it sits. */
function emitRoot(program: ts.Program): string {
  const authored = program
    .getSourceFiles()
    .filter(
      (source) =>
        !source.isDeclarationFile &&
        !program.isSourceFileFromExternalLibrary(source),
    )
    .map((source) => source.fileName);
  let root = dirname(authored[0] ?? ".");
  for (const file of authored)
    while (relative(root, file).startsWith(`..${sep}`)) root = dirname(root);
  return program.getCompilerOptions().rootDir ?? root;
}

/** The declaration TypeScript withheld for each module with a declaration error, at the path its emit would have used, mapped to that module. */
function withheldDeclarations(
  program: ts.Program,
  diagnostics: readonly ts.Diagnostic[],
  output: string,
  directory: string,
): Map<string, string> {
  const root = emitRoot(program);
  const withheld = new Map<string, string>();
  for (const { file } of diagnostics) {
    if (file === undefined || isTestSource(directory, file.fileName)) continue;
    const path = resolve(output, relative(root, file.fileName)).replace(
      /\.([cm]?)[jt]sx?$/u,
      ".d.$1ts",
    );
    withheld.set(path, file.fileName);
  }
  return withheld;
}

/** Emits with the package's compiler and config, or for JavaScript alone with the pack's when the package's has no compiler API; test roots and outputs never enter either proof. `modules` maps each emitted, copied or `withheld` file to its source module; `paths` is the configured `paths` with absolute targets. */
export function emitPackage(
  directory: string,
  output: string,
  declarations: boolean,
) {
  const { compiler, root, notice, parsed } = parseConfig(
    directory,
    !declarations,
  );
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
    failDiagnostics(compiler, [
      ...program.getConfigFileParsingDiagnostics(),
      ...program.getOptionsDiagnostics(),
      ...program.getSyntacticDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...program.getSemanticDiagnostics(),
    ]);
  const declarationDiagnostics = declarations
    ? program.getDeclarationDiagnostics()
    : [];
  const files: string[] = [];
  const modules = new Map<string, string>();
  program.emit(undefined, (file, text, _bom, _onError, sources) => {
    if (sources?.some((source) => isTestSource(directory, source.fileName)))
      return;
    if (declarations ? !/\.d\.[cm]?ts$/.test(file) : !/\.[cm]?jsx?$/.test(file))
      return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    files.push(file);
    if (sources?.[0] !== undefined)
      modules.set(resolve(file), sources[0].fileName);
  });
  const withheld = withheldDeclarations(
    program,
    declarationDiagnostics,
    output,
    directory,
  );
  if (declarations)
    files.push(...copyDeclarations(program, directory, output, modules));
  for (const [file, source] of withheld) modules.set(file, source);
  return {
    compiler,
    compilerRoot: root,
    notice,
    files,
    withheld: [...withheld.keys()],
    modules,
    options: parsed.options,
    paths: absolutePaths(parsed.options),
    /** The formatted declaration errors of the modules `sources` reach; empty when there are none. A declaration error in a module no published entry reaches never fails the proof. */
    declarationErrors(sources: readonly string[]): string {
      if (!declarationDiagnostics.length) return "";
      const reached = new Set(
        compiler
          .createProgram({
            rootNames: sources,
            options,
            projectReferences: parsed.projectReferences,
            oldProgram: program,
          })
          .getSourceFiles()
          .map((source) => source.fileName),
      );
      return formatErrors(
        compiler,
        declarationDiagnostics.filter(
          (item) => item.file !== undefined && reached.has(item.file.fileName),
        ),
      );
    },
  };
}
