import { execFileSync } from "node:child_process";
import {
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, posix } from "node:path";
import type ts from "typescript";

import { normalizeBundle } from "./declaration-order.ts";
import { resolveRevision } from "./files.ts";
import { compareRevisions } from "./revisions.ts";
import { loadTypeScript } from "./typescript.ts";

type Compiler = typeof ts;

/** One frontend module's auto-import lines, and the compiler notice its TypeScript resolution printed, if any. */
interface ModuleSurface {
  lines: string[];
  notice?: string;
}

/** A comparison result in the shape `apiDiff` joins: whether it differs and what to print. */
interface ProofHalf {
  different: boolean;
  output: string;
}

/** The file in which a DMS frontend module declares the directories the generated Vite config auto-imports. */
const BUILD_FILE = "dms.frontend.build.ts";

/** A module's private code, which the frontend build never auto-imports, whatever its declaration says. */
const PRIVATE_DIRECTORY = /(?:^|\/)app\/build(?:\/|$)/u;

/** The extensions unimport's directory scan reads exports from. */
const SCANNED_FILE = /\.(?:mts|cts|ts|tsx|mjs|cjs|js|jsx)$/u;

const NAME_SEPARATOR = /[-_.]/u;

const HINT =
  "Auto-imports: every export of a file under a directory that dms.frontend.build.ts passes to registerAutoImports is auto-imported into every frontend module, so a removed, added or changed name above changes what those modules compile against. @internal does not hide an auto-import and --allow-added does not apply to one. Keep removed and changed names (or release the change as breaking), and move a helper that must stay private under app/build/, which is never auto-imported.\n";

function moduleRoots(root: string, revision: string): string[] {
  return execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", revision], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(
      (file) =>
        (file === BUILD_FILE || file.endsWith(`/${BUILD_FILE}`)) &&
        !file.split("/").includes("node_modules"),
    )
    .map((file) => dirname(file))
    .sort();
}

/** The directories a build declaration passes to `registerAutoImports`, read without running it; only string literals can be read. */
function declaredDirectories(
  compiler: Compiler,
  file: string,
  label: string,
): string[] {
  const source = compiler.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    compiler.ScriptTarget.Latest,
    true,
  );
  const directories: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      compiler.isCallExpression(node) &&
      compiler.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "registerAutoImports"
    ) {
      const [entries] = node.arguments;
      const elements =
        entries !== undefined && compiler.isArrayLiteralExpression(entries)
          ? entries.elements
          : undefined;
      if (
        elements === undefined ||
        !elements.every((element) => compiler.isStringLiteralLike(element))
      )
        throw new Error(
          `${label}: registerAutoImports is not given an array of string literals, so api-diff cannot read which directories are auto-imported. Write the directories inline, as in registerAutoImports(["app/composables", ...]).`,
        );
      for (const element of elements)
        if (compiler.isStringLiteralLike(element))
          directories.push(element.text);
    }
    compiler.forEachChild(node, visit);
  };
  visit(source);
  return directories;
}

/** Whether the frontend build scans a declared directory: inside the module and outside `app/build/`, as `@antelopejs/dms-frontend` decides. */
function isScanned(directory: string): boolean {
  const path = posix.normalize(directory.split("\\").join("/"));
  return (
    !isAbsolute(directory) &&
    path !== ".." &&
    !path.startsWith("../") &&
    !PRIVATE_DIRECTORY.test(path)
  );
}

function scannedFiles(moduleRoot: string, directories: string[]): string[] {
  const files = new Set<string>();
  for (const directory of directories.filter(isScanned))
    for (const file of globSync(`${directory}/**/*`, { cwd: moduleRoot })) {
      const path = file.split("\\").join("/");
      if (
        SCANNED_FILE.test(path) &&
        !PRIVATE_DIRECTORY.test(path) &&
        !path.split("/").includes("node_modules") &&
        statSync(join(moduleRoot, path)).isFile()
      )
        files.add(join(moduleRoot, path));
    }
  return [...files].sort();
}

/** The `#<layer>/*` specifiers the frontend workspace maps to each `layers/<layer>` directory. */
function layerPaths(moduleRoot: string): Record<string, string[]> {
  const layers = join(moduleRoot, "layers");
  if (!existsSync(layers)) return {};
  return Object.fromEntries(
    readdirSync(layers, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => [`#${entry.name}/*`, [join(layers, entry.name, "*")]]),
  );
}

function compilerOptions(
  compiler: Compiler,
  moduleRoot: string,
): ts.CompilerOptions {
  const paths = layerPaths(moduleRoot);
  const config = join(moduleRoot, "tsconfig.json");
  const scan = { noEmit: true, allowJs: true, skipLibCheck: true };
  if (existsSync(config)) {
    const read = compiler.readConfigFile(config, compiler.sys.readFile);
    const parsed = compiler.parseJsonConfigFileContent(
      read.config ?? {},
      compiler.sys,
      moduleRoot,
    );
    return { ...parsed.options, ...scan, paths: parsed.options.paths ?? paths };
  }
  return {
    ...scan,
    target: compiler.ScriptTarget.ESNext,
    module: compiler.ModuleKind.ESNext,
    moduleResolution: compiler.ModuleResolutionKind.Bundler,
    strict: true,
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
    types: [],
    paths,
  };
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

const FORMAT_FLAGS = (compiler: Compiler) =>
  compiler.TypeFormatFlags.NoTruncation |
  compiler.TypeFormatFlags.UseStructuralFallback |
  compiler.TypeFormatFlags.WriteTypeArgumentsOfSignature;

/** Prints a type the way the declaration half compares bundles: members and union constituents in canonical order, on one line. */
function canonical(compiler: Compiler, text: string): string {
  return normalizeBundle(compiler, `type Surface = ${text};`)
    .replace(/^type Surface = /u, "")
    .replace(/;\s*$/u, "")
    .replace(/\s+/gu, " ")
    .replaceAll("[ ", "[")
    .replaceAll(" ]", "]");
}

function memberList(
  compiler: Compiler,
  checker: ts.TypeChecker,
  type: ts.Type,
  location: ts.Node,
): string {
  const flags = FORMAT_FLAGS(compiler);
  const print = (value: ts.Type) =>
    checker.typeToString(value, undefined, flags);
  const members = [
    ...checker
      .getSignaturesOfType(type, compiler.SignatureKind.Call)
      .map((signature) =>
        checker.signatureToString(
          signature,
          undefined,
          flags,
          compiler.SignatureKind.Call,
        ),
      ),
    ...checker
      .getSignaturesOfType(type, compiler.SignatureKind.Construct)
      .map((signature) =>
        checker.signatureToString(
          signature,
          undefined,
          flags,
          compiler.SignatureKind.Construct,
        ),
      ),
    ...checker
      .getIndexInfosOfType(type)
      .map(
        (info) =>
          `${info.isReadonly ? "readonly " : ""}[key: ${print(info.keyType)}]: ${print(info.type)}`,
      ),
    ...checker.getPropertiesOfType(type).map((property) => {
      const declaration = property.valueDeclaration;
      const readonly =
        declaration !== undefined &&
        (compiler.getCombinedModifierFlags(declaration) &
          compiler.ModifierFlags.Readonly) !==
          0;
      const optional = (property.flags & compiler.SymbolFlags.Optional) !== 0;
      return `${readonly ? "readonly " : ""}${JSON.stringify(property.name)}${optional ? "?" : ""}: ${print(checker.getTypeOfSymbolAtLocation(property, location))}`;
    }),
  ];
  return `{ ${members.join("; ")} }`;
}

function typeParameters(
  compiler: Compiler,
  checker: ts.TypeChecker,
  declaration: ts.Declaration | undefined,
): string {
  if (
    declaration === undefined ||
    !(
      compiler.isTypeAliasDeclaration(declaration) ||
      compiler.isInterfaceDeclaration(declaration) ||
      compiler.isClassDeclaration(declaration)
    ) ||
    declaration.typeParameters === undefined
  )
    return "";
  const flags = FORMAT_FLAGS(compiler);
  const print = (node: ts.TypeNode) =>
    checker.typeToString(checker.getTypeFromTypeNode(node), undefined, flags);
  return `<${declaration.typeParameters
    .map(
      (parameter) =>
        `${parameter.name.text}${parameter.constraint === undefined ? "" : ` extends ${print(parameter.constraint)}`}${parameter.default === undefined ? "" : ` = ${print(parameter.default)}`}`,
    )
    .join(", ")}>`;
}

/** One line per meaning of an auto-imported name: its value's type and, for a type, its declared structure. */
function describe(
  compiler: Compiler,
  checker: ts.TypeChecker,
  name: string,
  exported: ts.Symbol,
  source: ts.SourceFile,
): string[] {
  const symbol =
    (exported.flags & compiler.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(exported)
      : exported;
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  const location = declaration ?? source;
  const flags = FORMAT_FLAGS(compiler);
  const lines: string[] = [];
  const structured =
    compiler.SymbolFlags.Class |
    compiler.SymbolFlags.Enum |
    compiler.SymbolFlags.ValueModule;
  if ((symbol.flags & compiler.SymbolFlags.Value) !== 0) {
    const type = checker.getTypeOfSymbolAtLocation(symbol, location);
    const text =
      (symbol.flags & structured) !== 0
        ? memberList(compiler, checker, type, location)
        : checker.typeToString(type, undefined, flags);
    lines.push(`${name} (value): ${canonical(compiler, text)}`);
  }
  if (
    (symbol.flags & compiler.SymbolFlags.Type) !== 0 &&
    (symbol.flags & compiler.SymbolFlags.Enum) === 0
  ) {
    const type = checker.getDeclaredTypeOfSymbol(symbol);
    const text =
      (symbol.flags & compiler.SymbolFlags.TypeAlias) !== 0
        ? checker.typeToString(
            type,
            undefined,
            flags | compiler.TypeFormatFlags.InTypeAlias,
          )
        : memberList(compiler, checker, type, location);
    lines.push(
      `${name} (type)${typeParameters(compiler, checker, declaration)}: ${canonical(compiler, text)}`,
    );
  }
  return lines;
}

/** The auto-import surface of one frontend module: one sorted line per name and meaning that unimport would expose from its scanned files. Exports are read with the module's compiler, so `export *` and inferred types resolve as the frontend workspace types them. */
function moduleSurface(worktree: string, directory: string): ModuleSurface {
  const moduleRoot = join(worktree, directory);
  const { compiler, notice } = loadTypeScript(moduleRoot);
  const files = scannedFiles(
    moduleRoot,
    declaredDirectories(
      compiler,
      join(moduleRoot, BUILD_FILE),
      posix.join(directory, BUILD_FILE),
    ),
  );
  const program = compiler.createProgram(
    files,
    compilerOptions(compiler, moduleRoot),
  );
  const checker = program.getTypeChecker();
  const lines = new Set<string>();
  for (const file of files) {
    const source = program.getSourceFile(file);
    const owner =
      source === undefined ? undefined : checker.getSymbolAtLocation(source);
    if (source === undefined || owner === undefined) continue;
    for (const exported of checker.getExportsOfModule(owner))
      for (const line of describe(
        compiler,
        checker,
        exported.name === "default" ? defaultExportName(file) : exported.name,
        exported,
        source,
      ))
        lines.add(line.split(worktree).join("<root>"));
  }
  return { lines: [...lines].sort(), notice };
}

/** Compares the names and signatures each DMS frontend module auto-imports (the exports of the directories its `dms.frontend.build.ts` declares, without `app/build/`) at the base and at committed HEAD. Undefined when neither revision has a frontend module. */
export function autoImportDiff(
  root: string,
  baseRef: string,
): ProofHalf | undefined {
  if (
    [baseRef, "HEAD"].every(
      (ref) => moduleRoots(root, resolveRevision(root, ref)).length === 0,
    )
  )
    return undefined;
  const notices = new Set<string>();
  const result = compareRevisions(
    root,
    baseRef,
    "Auto-imports",
    (worktree, output) => {
      const directories = moduleRoots(worktree, "HEAD");
      let entries = 0;
      for (const directory of directories) {
        const { lines, notice } = moduleSurface(worktree, directory);
        if (notice !== undefined) notices.add(notice);
        const path = join(
          output,
          directory === "." ? "_root" : directory,
          "auto-imports.txt",
        );
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, lines.map((line) => `${line}\n`).join(""));
        entries += lines.length;
      }
      return { packages: directories, entries };
    },
  );
  return {
    different: result.different,
    output: `${result.output}${result.different ? HINT : ""}${[...notices].sort().join("")}`,
  };
}
