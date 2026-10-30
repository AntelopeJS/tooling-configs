import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";

import { sourcePaths } from "./sources.mjs";

/** Each complete example is an isolated module, even without imports. */
const MODULE_SUFFIX = "\nexport {};\n";

/** TS18003 (no inputs found) is expected when only virtual examples and API entries are roots. */
const NO_INPUTS_FOUND = 18003;

/** Options that tie a program to its build layout, which virtual examples beside Markdown files break. */
const DOCS_PROGRAM_OPTIONS = {
  noEmit: true,
  noCheck: false,
  composite: false,
  incremental: false,
  rootDir: undefined,
  outDir: undefined,
  declarationDir: undefined,
  tsBuildInfoFile: undefined,
  emitDeclarationOnly: undefined,
};

function loadTypescript(project) {
  try {
    return createRequire(project)("typescript");
  } catch {
    return undefined;
  }
}

/**
 * Resolves the consumer's compiler, types, and imports, with the repository's
 * own package names mapped to their source. No examples are executed, no output
 * is emitted, and no temporary source files are written into its tree.
 */
export function checkTypescript({ root, project, documents, fail }) {
  const display = (path) => relative(root, path);
  const ts = loadTypescript(project);
  if (!ts) {
    fail(
      `${display(project)}: TypeScript does not resolve from this tsconfig; install the checkout's dependencies before the docs action`,
    );
    return 0;
  }
  const config = ts.readConfigFile(project, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    config.config ?? {},
    ts.sys,
    dirname(project),
    undefined,
    project,
  );
  const options = {
    ...parsed.options,
    ...DOCS_PROGRAM_OPTIONS,
    paths: { ...parsed.options.paths, ...sourcePaths(ts, root) },
  };
  const virtual = new Map();
  const sources = new Set(parsed.fileNames);
  const api = [];
  for (const doc of documents) {
    let index = 0;
    for (const example of doc.examples) {
      const name = `${doc.path}.docs-check-${++index}.${example.extension}`;
      virtual.set(name, {
        doc,
        example,
        text: `${example.text}${MODULE_SUFFIX}`,
      });
      sources.add(name);
    }
    for (const entry of doc.api) {
      const path = resolve(dirname(doc.path), entry);
      sources.add(path);
      api.push({ doc, path });
    }
  }
  const host = ts.createCompilerHost(options);
  const originalRead = host.readFile;
  const originalExists = host.fileExists;
  const originalSource = host.getSourceFile;
  host.readFile = (path) => virtual.get(path)?.text ?? originalRead(path);
  host.fileExists = (path) => virtual.has(path) || originalExists(path);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNew) =>
    virtual.has(path)
      ? ts.createSourceFile(path, virtual.get(path).text, languageVersion, true)
      : originalSource(path, languageVersion, onError, shouldCreateNew);
  const program = ts.createProgram({
    rootNames: [...sources],
    options,
    host,
  });
  const location = (diagnostic) => {
    if (!diagnostic.file) return display(project);
    const { line } = diagnostic.file.getLineAndCharacterOfPosition(
      diagnostic.start ?? 0,
    );
    const example = virtual.get(diagnostic.file.fileName);
    if (!example) return `${display(diagnostic.file.fileName)}:${line + 1}`;
    return `${display(example.doc.path)}:${example.example.line + line}`;
  };
  for (const diagnostic of [
    ...(config.error ? [config.error] : []),
    ...parsed.errors.filter(
      (error) => error.code !== NO_INPUTS_FOUND || sources.size === 0,
    ),
    ...ts.getPreEmitDiagnostics(program),
  ]) {
    fail(
      `${location(diagnostic)}: TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
    );
  }
  const checker = program.getTypeChecker();
  for (const { doc, path } of api) {
    const source = program.getSourceFile(path);
    const symbol = source && checker.getSymbolAtLocation(source);
    if (!symbol) {
      fail(`${doc.path}: docs-api entry is not a TypeScript module: ${path}`);
      continue;
    }
    const exported = new Set(
      checker.getExportsOfModule(symbol).map((entry) => entry.getName()),
    );
    for (const name of exported) {
      if (!doc.exports.has(name)) {
        fail(`${doc.path}: missing API heading for export ${name}`);
      }
    }
    for (const name of doc.exports) {
      if (!exported.has(name)) {
        fail(`${doc.path}: API heading ${name} is not exported by ${path}`);
      }
    }
  }
  return virtual.size;
}
