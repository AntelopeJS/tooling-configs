import { spawnSync } from "node:child_process";
import { extname } from "node:path";
import ts from "typescript";

/** One top-level item of a covered file: its structure decides equality, its text only describes it. */
export interface EmitItem {
  structure: string;
  text: string;
  hoisted: boolean;
}

/** What the covered code does at a commit: the function declarations of every covered file, and each file's other top-level items in order. */
export interface EmitFingerprint {
  functions: EmitItem[];
  files: Record<string, EmitItem[]>;
}

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
]);
const OUTPUT_LIMIT = 64 * 1024 * 1024;
const TEXT_LENGTH = 160;

function fileAt(repo: string, sha: string, path: string): string | null {
  const shown = spawnSync("git", ["show", `${sha}:${path}`], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: OUTPUT_LIMIT,
  });
  return shown.status === 0 ? shown.stdout : null;
}

function leafOf(node: ts.Node): string {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isNumericLiteral(node)) return String(Number(node.text));
  if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node))
    return JSON.stringify(node.text);
  if (ts.isBigIntLiteral(node) || ts.isRegularExpressionLiteral(node))
    return node.text;
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
    return ts.SyntaxKind[node.operator];
  if (ts.isVariableDeclarationList(node))
    return String(node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const));
  if (ts.isMetaProperty(node)) return ts.SyntaxKind[node.keywordToken];
  return "";
}

function dropped(node: ts.Node): boolean {
  return (
    node.kind === ts.SyntaxKind.ExportKeyword ||
    node.kind === ts.SyntaxKind.DefaultKeyword
  );
}

/**
 * The structure of a node: its kind, its identifier name or literal value,
 * and its children's structure, with parentheses, positions, trivia, quote
 * style and line breaks left out, so formatting never changes it.
 */
function structureOf(node: ts.Node): string {
  if (ts.isParenthesizedExpression(node)) return structureOf(node.expression);
  const children: string[] = [];
  ts.forEachChild(node, (child) => {
    if (!dropped(child)) children.push(structureOf(child));
  });
  return `${ts.SyntaxKind[node.kind]}(${leafOf(node)}|${children.join(",")})`;
}

function readable(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TEXT_LENGTH ? `${flat.slice(0, TEXT_LENGTH)}…` : flat;
}

function scriptItems(path: string, source: string): EmitItem[] {
  const { outputText } = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      removeComments: true,
      experimentalDecorators: true,
    },
  });
  const file = ts.createSourceFile(
    "emit.js",
    outputText,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  );
  return file.statements
    .filter(
      (statement) =>
        !ts.isImportDeclaration(statement) &&
        !ts.isExportDeclaration(statement),
    )
    .map((statement) => ({
      structure: structureOf(statement),
      text: readable(statement.getText(file)),
      hoisted: ts.isFunctionDeclaration(statement) && Boolean(statement.body),
    }));
}

function vueItems(path: string, source: string): EmitItem[] {
  const scripts = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  const template = /<template\b[^>]*>([\s\S]*)<\/template>/.exec(source);
  const markup = template ? template[1].replace(/\s+/g, " ").trim() : null;
  return [
    ...scripts.flatMap(([, body]) => scriptItems(`${path}.ts`, body)),
    ...(markup === null
      ? []
      : [
          {
            structure: `template(${markup})`,
            text: readable(`<template> ${markup}`),
            hoisted: false,
          },
        ]),
  ];
}

function itemsOf(path: string, source: string): EmitItem[] {
  if (path.endsWith(".vue")) return vueItems(path, source);
  if (CODE_EXTENSIONS.has(extname(path))) return scriptItems(path, source);
  const flat = source.replace(/\s+/g, " ").trim();
  return [{ structure: `file(${flat})`, text: readable(flat), hoisted: false }];
}

/**
 * What the covered code does at a commit, as structure rather than text:
 * each covered file's top-level statements in order, and, apart, the
 * function declarations of every covered file, which hoisting lets move
 * freely. Types, comments, formatting, imports and export keywords are left
 * out, so a type-only edit, a reformat, or moving a function declaration to
 * another covered file keeps the same fingerprint, while reordering or
 * moving any other statement changes it.
 */
export function emitFingerprint(
  repo: string,
  sha: string,
  files: string[],
): EmitFingerprint {
  const fingerprint: EmitFingerprint = { functions: [], files: {} };
  for (const path of files) {
    const source = fileAt(repo, sha, path);
    if (source === null) continue;
    const items = itemsOf(path, source);
    fingerprint.functions.push(...items.filter((item) => item.hoisted));
    fingerprint.files[path] = items.filter((item) => !item.hoisted);
  }
  return fingerprint;
}
