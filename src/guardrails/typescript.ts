import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, matchesGlob, relative, sep } from "node:path";
import type ts from "typescript";

import { trackedManifests } from "./revisions.ts";

export type ExportTarget =
  | string
  | null
  | ExportTarget[]
  | { [condition: string]: ExportTarget };

export interface ProofManifest {
  private?: boolean;
  exports?: ExportTarget;
  main?: string;
  types?: string;
  typings?: string;
  typesVersions?: Record<string, Record<string, string[]>>;
}

export function packagesAt(root: string, publishedOnly: boolean) {
  return trackedManifests(root).flatMap((file) => {
    const directory = dirname(file);
    if (!existsSync(join(root, directory, "tsconfig.json"))) return [];
    /* SAFETY: tracked package manifests provide the standard optional publication fields. */
    const manifest = JSON.parse(
      readFileSync(join(root, file), "utf8"),
    ) as ProofManifest;
    if (publishedOnly && manifest.private === true) return [];
    return [{ directory, manifest }];
  });
}

/** Loads the consumer's compiler, including a package-local installation in a workspace. */
function loadTypeScript(directory: string): typeof ts {
  /* SAFETY: the consumer's typescript package implements the compiler API. */
  return createRequire(join(directory, "package.json"))(
    "typescript",
  ) as typeof ts;
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

/** Emits with the package's compiler and config; test roots and outputs never enter either proof. */
export function emitPackage(
  directory: string,
  output: string,
  declarations: boolean,
) {
  const compiler = loadTypeScript(directory);
  const configPath = join(directory, "tsconfig.json");
  const config = compiler.readConfigFile(configPath, compiler.sys.readFile);
  if (config.error) failDiagnostics(compiler, [config.error]);
  const parsed = compiler.parseJsonConfigFileContent(
    config.config,
    compiler.sys,
    directory,
  );
  failDiagnostics(compiler, parsed.errors);
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
    },
  );
  if (declarations) failDiagnostics(compiler, result.diagnostics);
  if (declarations) files.push(...copyDeclarations(program, directory, output));
  return { compiler, files, options: parsed.options };
}
