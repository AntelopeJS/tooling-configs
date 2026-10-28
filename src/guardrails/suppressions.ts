import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type ts from "typescript";

import { generatedOutput, gitFiles } from "./files.ts";

/**
 * One suppression in an authored code file, at the line where its comment
 * starts. A lint directive yields one `rule` entry per rule it names, and one
 * with rule `*` when it names none.
 */
export type Suppression =
  | {
      kind: "rule";
      rule: string;
      directive: string;
      file: string;
      line: number;
    }
  | {
      kind: "tsExpectError" | "tsIgnore" | "safety";
      file: string;
      line: number;
    };

/** Suppression totals: lint directives per named rule (`*` for none), then each comment kind. */
export interface SuppressionCounts {
  rules: Record<string, number>;
  tsExpectError: number;
  tsIgnore: number;
  safety: number;
}

/** A comment without its delimiters, whether it is a line comment, and its offset in the file. */
interface CommentText {
  value: string;
  line: boolean;
  start: number;
}

const CODE_FILE = /\.(?:[cm]?[jt]sx?|vue)$/u;
const CANDIDATE =
  /(?:oxlint|eslint)-disable|@ts-(?:expect-error|ignore)|SAFETY:/u;
const LINT_DIRECTIVE =
  /^((?:oxlint|eslint)-disable(?:-line|-next-line)?)(?=\s|$)([\s\S]*)$/u;
const DESCRIPTION = /\s-{2,}\s|\s-{2,}$/u;
const TS_DIRECTIVE = /^[/*\s]*@ts-(expect-error|ignore)(?![\w-])/u;

let compiler: typeof ts | undefined;

/** The TypeScript that `dts-bundle-generator` brings, so the count never depends on the consumer's compiler. */
function typescript(): typeof ts {
  if (compiler !== undefined) return compiler;
  const own = createRequire(import.meta.url);
  /* SAFETY: dts-bundle-generator depends on a TypeScript with the parser API, whatever the repository installs. */
  compiler = createRequire(own.resolve("dts-bundle-generator"))(
    "typescript",
  ) as typeof ts;
  return compiler;
}

function scriptKind(lang: string): ts.ScriptKind {
  const kinds = typescript().ScriptKind;
  if (/^[cm]?tsx$/u.test(lang)) return kinds.TSX;
  if (/^[cm]?ts$/u.test(lang)) return kinds.TS;
  return lang.endsWith("x") ? kinds.JSX : kinds.JS;
}

/** Every comment the parser sees, so string, template and JSX text that only looks like a comment is never read. */
function scriptComments(
  text: string,
  kind: ts.ScriptKind,
  offset: number,
): CommentText[] {
  const compiler = typescript();
  const source = compiler.createSourceFile(
    "suppressions",
    text,
    compiler.ScriptTarget.Latest,
    false,
    kind,
  );
  const ranges = new Map<number, ts.CommentRange>();
  const visit = (node: ts.Node) => {
    if (node.kind === compiler.SyntaxKind.JsxText) return;
    if (node.kind !== compiler.SyntaxKind.SyntaxList)
      for (const range of [
        ...(compiler.getTrailingCommentRanges(text, node.pos) ?? []),
        ...(compiler.getLeadingCommentRanges(text, node.pos) ?? []),
      ])
        ranges.set(range.pos, range);
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return [...ranges.values()].map((range) => {
    const line = range.kind === compiler.SyntaxKind.SingleLineCommentTrivia;
    return {
      value: text.slice(range.pos + 2, line ? range.end : range.end - 2),
      line,
      start: offset + range.pos,
    };
  });
}

function blank(text: string): string {
  return text.replaceAll(/[^\n]/gu, " ");
}

/** Script blocks are parsed; outside script and style blocks, HTML comments carry template directives. */
function vueComments(text: string): CommentText[] {
  const comments: CommentText[] = [];
  let template = text;
  for (const block of text.matchAll(
    /(<script\b([^>]*)>)([\s\S]*?)<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gu,
  )) {
    template =
      template.slice(0, block.index) +
      blank(block[0]) +
      template.slice(block.index + block[0].length);
    if (block[1] === undefined) continue;
    const lang = /\blang\s*=\s*["']?([\w-]+)/u.exec(block[2])?.[1] ?? "js";
    comments.push(
      ...scriptComments(
        block[3],
        scriptKind(lang),
        block.index + block[1].length,
      ),
    );
  }
  for (const comment of template.matchAll(/<!--([\s\S]*?)-->/gu))
    comments.push({ value: comment[1], line: false, start: comment.index });
  return comments;
}

function lintDirective(value: string) {
  const text = value.replace(/^\s*\*?\s*/u, "");
  const directive = LINT_DIRECTIVE.exec(text);
  if (directive === null) return [];
  const rules = directive[2]
    .split(DESCRIPTION)[0]
    .split(",")
    .map((rule) => rule.trim())
    .filter(Boolean);
  return (rules.length ? rules : ["*"]).map((rule) => ({
    directive: directive[1],
    rule,
  }));
}

/** TypeScript reads a directive from a line comment, or from the last line of a block comment. */
function tsDirective(comment: CommentText) {
  const text = comment.line
    ? comment.value
    : comment.value.slice(comment.value.lastIndexOf("\n") + 1);
  const match = TS_DIRECTIVE.exec(text);
  if (match === null) return undefined;
  return match[1] === "ignore" ? "tsIgnore" : "tsExpectError";
}

/** The suppressions in one code file's text; `file` decides the language and labels each entry. */
export function suppressionsIn(file: string, text: string): Suppression[] {
  if (!CODE_FILE.test(file) || !CANDIDATE.test(text)) return [];
  const comments = file.endsWith(".vue")
    ? vueComments(text)
    : scriptComments(
        text,
        scriptKind(file.slice(file.lastIndexOf(".") + 1)),
        0,
      );
  const found: Suppression[] = [];
  for (const comment of comments.sort((a, b) => a.start - b.start)) {
    const line = text.slice(0, comment.start).split("\n").length;
    for (const { directive, rule } of lintDirective(comment.value))
      found.push({ kind: "rule", rule, directive, file, line });
    const typeDirective = tsDirective(comment);
    if (typeDirective !== undefined)
      found.push({ kind: typeDirective, file, line });
    if (/^\s*\*?\s*SAFETY:/u.test(comment.value))
      found.push({ kind: "safety", file, line });
  }
  return found;
}

function authoredCode(root: string, files: string[]): string[] {
  const generated = generatedOutput(root);
  return files.filter((file) => CODE_FILE.test(file) && !generated(file));
}

/** Suppressions in the working tree's authored code files: tracked and untracked, ignored files and generated output left out. */
export function worktreeSuppressions(
  root: string,
  files = gitFiles(root),
): Suppression[] {
  return authoredCode(root, files).flatMap((file) => {
    const path = join(root, file);
    if (!existsSync(path) || !lstatSync(path).isFile()) return [];
    return suppressionsIn(file, readFileSync(path, "utf8"));
  });
}

function blobs(root: string, specs: string[]): (string | undefined)[] {
  if (!specs.length) return [];
  const output = execFileSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: `${specs.join("\n")}\n`,
    maxBuffer: 1024 * 1024 * 1024,
  });
  const texts: (string | undefined)[] = [];
  let offset = 0;
  for (let index = 0; index < specs.length; index++) {
    const newline = output.indexOf(10, offset);
    const [, type, size] = output
      .subarray(offset, newline)
      .toString()
      .split(" ");
    offset = newline + 1;
    if (size === undefined) {
      texts.push(undefined);
      continue;
    }
    const end = offset + Number(size);
    texts.push(
      type === "blob" ? output.subarray(offset, end).toString() : undefined,
    );
    offset = end + 1;
  }
  return texts;
}

/**
 * Suppressions in authored code files at a committed revision, or in the
 * index when `revision` is the empty string. Without `files` every file of
 * that tree is read.
 */
export function revisionSuppressions(
  root: string,
  revision: string,
  files?: string[],
): Suppression[] {
  const listed =
    files ??
    execFileSync(
      "git",
      revision === ""
        ? ["ls-files", "-z"]
        : ["ls-tree", "-r", "-z", "--name-only", revision],
      { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    )
      .split("\0")
      .filter(Boolean);
  const code = authoredCode(root, listed);
  const texts = blobs(
    root,
    code.map((file) => `${revision}:${file}`),
  );
  return code.flatMap((file, index) => {
    const text = texts[index];
    return text === undefined ? [] : suppressionsIn(file, text);
  });
}

/** Totals by budget key, rules sorted by id. */
export function countSuppressions(
  suppressions: Suppression[],
): SuppressionCounts {
  const counts: SuppressionCounts = {
    rules: {},
    tsExpectError: 0,
    tsIgnore: 0,
    safety: 0,
  };
  for (const suppression of suppressions) {
    if (suppression.kind === "rule")
      counts.rules[suppression.rule] =
        (counts.rules[suppression.rule] ?? 0) + 1;
    else counts[suppression.kind]++;
  }
  counts.rules = Object.fromEntries(
    Object.entries(counts.rules).sort(([a], [b]) => a.localeCompare(b)),
  );
  return counts;
}
