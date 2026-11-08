import { resolve } from "node:path";
import ts from "typescript";

import { programConfig, project } from "./tsconfig-program.ts";

/** A linted file as the TypeScript program of its tsconfig types it. */
export interface TypedFile {
  checker: ts.TypeChecker;
  options: ts.CompilerOptions;
  sourceFile: ts.SourceFile;
}

const programs = new Map<string, ts.Program>();

function normalize(file: string): string {
  return resolve(file).replaceAll("\\", "/");
}

function build(
  config: string,
  path: string,
  text: string,
): ts.Program | undefined {
  const parsed = project(config);
  if (parsed === undefined) return undefined;
  const host = ts.createCompilerHost(parsed.options, true);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, language, ...rest) =>
    normalize(name) === path
      ? ts.createSourceFile(name, text, language, true)
      : read(name, language, ...rest);
  const program = ts.createProgram({
    rootNames: [...parsed.files],
    options: parsed.options,
    host,
    oldProgram: programs.get(config),
  });
  programs.set(config, program);
  return program;
}

/**
 * The type checker of the tsconfig program that lists `file`, built once per
 * lint run and rebuilt from the previous one when `text` differs from what it
 * read. Undefined when no tsconfig lists the file.
 */
export function typedFile(file: string, text: string): TypedFile | undefined {
  const config = programConfig(file);
  if (config === undefined) return undefined;
  const path = normalize(file);
  const cached = programs.get(config);
  const program =
    cached?.getSourceFile(path)?.text === text
      ? cached
      : build(config, path, text);
  const sourceFile = program?.getSourceFile(path);
  return program && sourceFile
    ? {
        checker: program.getTypeChecker(),
        options: program.getCompilerOptions(),
        sourceFile,
      }
    : undefined;
}

/** The node `test` accepts that spans exactly `start` to `end`, the span oxlint gives the matching ESTree node. */
export function nodeAt<T extends ts.Node>(
  sourceFile: ts.SourceFile,
  span: { start: number; end: number },
  test: (node: ts.Node) => node is T,
): T | undefined {
  let found: T | undefined;
  function visit(node: ts.Node): void {
    if (found !== undefined || node.pos > span.start || node.end < span.end)
      return;
    if (
      test(node) &&
      node.getStart(sourceFile) === span.start &&
      node.end === span.end
    )
      found = node;
    else ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}
