import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  matchesGlob,
  relative,
  resolve,
  sep,
} from "node:path";
import ts from "../typescript6.ts";

import { declaresTypeScript, describePackage } from "./declared-typescript.ts";
import { workspaceDirectories, workspacePatterns } from "./docs-compat.ts";
import { gitFiles, trackedManifests } from "./files.ts";
import {
  installedCompilerDefaults,
  installedTypeScriptMajor,
} from "./installed-typescript.ts";

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

/** Whether the package at `directory` belongs to the workspace at `root`: always when `root` declares none or lists a pattern with glob syntax beyond `*`, `?` and `**`, else when it is `root` or a listed member. */
function workspaceMember(root: string): (directory: string) => boolean {
  const pnpm = existsSync(join(root, "pnpm-workspace.yaml"));
  if (!pnpm && !existsSync(join(root, "package.json"))) return () => true;
  const patterns = workspacePatterns(root);
  if (
    (!pnpm && !patterns.length) ||
    patterns.some((pattern) => /[{}[\]()]/u.test(pattern))
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

/** The TypeScript major the package at `directory` builds with, which decides how its config reads; undefined when it declares none. A package that declares `typescript` (itself or through its workspace root) but cannot resolve it is an error. */
function packageMajor(directory: string): number | undefined {
  const major = installedTypeScriptMajor(directory);
  if (major === undefined && declaresTypeScript(directory))
    throw new Error(
      `${describePackage(directory)} declares typescript but it cannot be resolved from the package directory, so the compiler version it builds with is not known. Install dependencies (run pnpm install) and retry.`,
    );
  return major;
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

function formatErrors(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnostics(
    diagnostics.filter((item) => item.category === ts.DiagnosticCategory.Error),
    {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    },
  );
}

function failDiagnostics(diagnostics: readonly ts.Diagnostic[]): void {
  const errors = formatErrors(diagnostics);
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

function readConfig(
  directory: string,
  file = join(directory, "tsconfig.json"),
) {
  const config = ts.readConfigFile(file, ts.sys.readFile);
  if (config.error) failDiagnostics([config.error]);
  return ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirname(file),
    undefined,
    file,
  );
}

/** Parses `file`, by default the package's `tsconfig.json`, as the package's own `tsc -p` would, failing on any configuration error. */
function parseConfig(directory: string, file?: string) {
  const parsed = readConfig(directory, file);
  failDiagnostics(parsed.errors);
  const defaults = installedCompilerDefaults(
    parsed.options,
    packageMajor(directory),
  );
  return {
    ...parsed,
    defaults,
    options: {
      ...parsed.options,
      ...ts.convertCompilerOptionsFromJson(defaults, directory).options,
    },
  };
}

/** The package's other configs that emit declarations, such as a `bin/tsconfig.types.json` only its build script names, each with its absolute `outDir`. */
function declarationConfigs(
  directory: string,
): { config: string; outDir: string }[] {
  const main = join(directory, "tsconfig.json");
  return gitFiles(directory).flatMap((path) => {
    const config = join(directory, path);
    if (config === main || !/^tsconfig.*\.json$/u.test(basename(path)))
      return [];
    const { options } = readConfig(directory, config);
    const emits =
      options.noEmit !== true &&
      (options.declaration === true || options.composite === true);
    return emits && options.outDir !== undefined
      ? [{ config, outDir: resolve(options.outDir) }]
      : [];
  });
}

/** Whether `tsconfig.json` has an empty `files` list, references nothing, and so parses to no inputs. */
export function listsNoFiles(directory: string): boolean {
  const parsed = readConfig(directory);
  return (
    parsed.fileNames.length === 0 &&
    parsed.errors.some((error) => error.code === EMPTY_FILES_LIST)
  );
}

/** The absolute paths of the configs `tsconfig.json` extends, directly or through another config. */
export function extendedConfigs(directory: string): string[] {
  const file = join(directory, "tsconfig.json");
  const source = ts.readJsonConfigFile(file, ts.sys.readFile);
  ts.parseJsonSourceFileConfigFileContent(
    source,
    ts.sys,
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
  return resolve(directory, parseConfig(directory).options.outDir ?? ".");
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

/** Emits `config`, by default the package's `tsconfig.json`, with the pack's TypeScript 6, reading it as the TypeScript the package installs does, and lays the output out under `rootDir`, else the common directory of its sources as TypeScript 5 does; test roots and outputs never enter either proof. `defaults` is what `installedCompilerDefaults` adds to the config. `modules` maps each emitted, copied or `withheld` file to its source module; `paths` is the configured `paths` with absolute targets. */
export function emitPackage(
  directory: string,
  output: string,
  declarations: boolean,
  config?: string,
) {
  const parsed = parseConfig(directory, config);
  const configured: ts.CompilerOptions = {
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
  const rootNames = parsed.fileNames.filter(
    (file) => !isTestSource(directory, file),
  );
  const projectReferences = parsed.projectReferences;
  const laidOut = ts.createProgram({
    rootNames,
    options: configured,
    projectReferences,
  });
  const options: ts.CompilerOptions = {
    ...configured,
    rootDir: configured.rootDir ?? emitRoot(laidOut),
  };
  const program =
    configured.rootDir === undefined
      ? ts.createProgram({
          rootNames,
          options,
          projectReferences,
          oldProgram: laidOut,
        })
      : laidOut;
  if (declarations)
    failDiagnostics([
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
    defaults: parsed.defaults,
    files,
    withheld: [...withheld.keys()],
    modules,
    options: parsed.options,
    paths: absolutePaths(parsed.options),
    /** The formatted declaration errors of the modules `sources` reach; empty when there are none. A declaration error in a module no published entry reaches never fails the proof. */
    declarationErrors(sources: readonly string[]): string {
      if (!declarationDiagnostics.length) return "";
      const reached = new Set(
        ts
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
        declarationDiagnostics.filter(
          (item) => item.file !== undefined && reached.has(item.file.fileName),
        ),
      );
    },
  };
}

/** The emit of `tsconfig.json`, joined by the emit of each other declaration config of the package whose `outDir` lies below the main output and holds one of the published `targets`, laid out at that place in `scratch`. */
export function emitDeclarations(
  directory: string,
  scratch: string,
  targets: readonly string[],
) {
  const main = emitPackage(directory, scratch, true);
  const outputRoot = resolve(directory, main.options.outDir ?? ".");
  const below = (root: string, path: string) => {
    const inner = relative(root, path);
    return (
      inner !== "" &&
      inner !== ".." &&
      !inner.startsWith(`..${sep}`) &&
      !isAbsolute(inner)
    );
  };
  const others = declarationConfigs(directory)
    .filter(
      ({ outDir }) =>
        below(outputRoot, outDir) &&
        targets.some((target) => below(outDir, target)),
    )
    .map(({ config, outDir }) =>
      emitPackage(
        directory,
        join(scratch, relative(outputRoot, outDir)),
        true,
        config,
      ),
    );
  const emits = [main, ...others];
  return {
    ...main,
    files: emits.flatMap(({ files }) => files),
    withheld: emits.flatMap(({ withheld }) => withheld),
    modules: new Map(emits.flatMap(({ modules }) => [...modules])),
    declarationErrors: (sources: readonly string[]) =>
      emits.map((emit) => emit.declarationErrors(sources)).join(""),
  };
}
