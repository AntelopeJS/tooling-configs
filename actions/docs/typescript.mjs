import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";

/** Each complete example is an isolated module, even without imports. */
const MODULE_SUFFIX = "\nexport {};\n";

/** TS18003 (no inputs found) is expected when only virtual examples and API entries are roots. */
const NO_INPUTS_FOUND = 18003;

/**
 * Resolves the consumer's compiler, types, and imports. No examples are executed,
 * no output is emitted, and no temporary source files are written into its tree.
 */
export function checkTypescript(project, documents, fail) {
  const ts = createRequire(project)("typescript");
  const config = ts.readConfigFile(project, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    config.config ?? {},
    ts.sys,
    dirname(project),
    { noEmit: true, noCheck: false },
    project,
  );
  const virtual = new Map();
  const sources = new Set(parsed.fileNames);
  const api = [];
  for (const doc of documents) {
    let index = 0;
    for (const example of doc.examples) {
      const name = `${doc.path}.docs-check-${++index}.${example.extension}`;
      virtual.set(name, `${example.text}${MODULE_SUFFIX}`);
      sources.add(name);
    }
    for (const entry of doc.api) {
      const path = resolve(dirname(doc.path), entry);
      sources.add(path);
      api.push({ doc, path });
    }
  }
  const host = ts.createCompilerHost(parsed.options);
  const originalRead = host.readFile;
  const originalExists = host.fileExists;
  const originalSource = host.getSourceFile;
  host.readFile = (path) => virtual.get(path) ?? originalRead(path);
  host.fileExists = (path) => virtual.has(path) || originalExists(path);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNew) =>
    virtual.has(path)
      ? ts.createSourceFile(path, virtual.get(path), languageVersion, true)
      : originalSource(path, languageVersion, onError, shouldCreateNew);
  const program = ts.createProgram({
    rootNames: [...sources],
    options: parsed.options,
    projectReferences: parsed.projectReferences,
    host,
  });
  for (const diagnostic of [
    ...(config.error ? [config.error] : []),
    ...parsed.errors.filter(
      (error) => error.code !== NO_INPUTS_FOUND || sources.size === 0,
    ),
    ...ts.getPreEmitDiagnostics(program),
  ]) {
    const position = diagnostic.file?.getLineAndCharacterOfPosition(
      diagnostic.start ?? 0,
    );
    const location = diagnostic.file
      ? `${relative(process.cwd(), diagnostic.file.fileName)}:${position.line + 1}`
      : project;
    fail(
      `${location}: TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
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
