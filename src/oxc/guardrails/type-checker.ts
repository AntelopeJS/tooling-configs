import { resolve } from "node:path";
import ts from "@typescript/typescript6";

import { programConfig, project } from "./tsconfig-program.ts";
import { scriptView } from "./vue-script.ts";

/** A linted file as the TypeScript program of its tsconfig types it. */
export interface TypedFile {
  checker: ts.TypeChecker;
  options: ts.CompilerOptions;
  sourceFile: ts.SourceFile;
}

const programs = new Map<string, ts.Program>();

/** The source files every program of the lint run shares, parsed once per text and per set of compiler options that change a parse. */
const documents = ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames);

function normalize(file: string): string {
  return resolve(file).replaceAll("\\", "/");
}

function isVue(path: string): boolean {
  return path.endsWith(".vue");
}

/** A file as the program reads it: a component as its script view, undefined when it has none, and any other file as written. */
function viewOf(path: string, text: string): string | undefined {
  return isVue(path) ? scriptView(text) : text;
}

function readView(host: ts.CompilerHost, name: string): string | undefined {
  const text = host.readFile(name);
  return text === undefined ? undefined : viewOf(name, text);
}

function build(
  config: string,
  path: string,
  view: string,
): ts.Program | undefined {
  const parsed = project(config);
  if (parsed === undefined) return undefined;
  const rootNames = [...parsed.files];
  const options = rootNames.some(isVue)
    ? { ...parsed.options, allowNonTsExtensions: true }
    : parsed.options;
  const host = ts.createCompilerHost(options, true);
  host.getSourceFile = (name, language) => {
    const content = normalize(name) === path ? view : readView(host, name);
    return content === undefined
      ? undefined
      : documents.acquireDocument(
          name,
          options,
          ts.ScriptSnapshot.fromString(content),
          content,
          undefined,
          language,
        );
  };
  const program = ts.createProgram({
    rootNames,
    options,
    host,
    oldProgram: programs.get(config),
  });
  programs.set(config, program);
  return program;
}

/**
 * The type checker of the tsconfig program that lists `file`, built once per
 * lint run and rebuilt from the previous one when `text` differs from what it
 * read. Undefined when no tsconfig lists the file, or when it is a component
 * with no script view.
 */
export function typedFile(file: string, text: string): TypedFile | undefined {
  const config = programConfig(file);
  if (config === undefined) return undefined;
  const path = normalize(file);
  const view = viewOf(path, text);
  if (view === undefined) return undefined;
  const cached = programs.get(config);
  const program =
    cached?.getSourceFile(path)?.text === view
      ? cached
      : build(config, path, view);
  const sourceFile = program?.getSourceFile(path);
  return program && sourceFile
    ? {
        checker: program.getTypeChecker(),
        options: program.getCompilerOptions(),
        sourceFile,
      }
    : undefined;
}

/** The node `test` accepts that spans exactly the `range` of an ESTree node, as oxlint and ESLint give it. */
export function nodeAt<T extends ts.Node>(
  sourceFile: ts.SourceFile,
  { range: [start, end] }: { range: readonly [number, number] },
  test: (node: ts.Node) => node is T,
): T | undefined {
  let found: T | undefined;
  function visit(node: ts.Node): void {
    if (found !== undefined || node.pos > start || node.end < end) return;
    if (test(node) && node.getStart(sourceFile) === start && node.end === end)
      found = node;
    else ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}
