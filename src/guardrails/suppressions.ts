import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type ts from "typescript";

import {
  DEFAULT_SAFETY_MARKERS,
  markerPattern,
} from "../oxc/anti-slop/rules/require-safety-comment-for-type-assertion.ts";
import { configRuleOffs, LINT_CONFIG_FILE } from "./config-suppressions.ts";
import { generatedOutput, gitFiles } from "./files.ts";
import { typescript } from "./parser.ts";

/**
 * One suppression in an authored code file, at the line where its comment
 * starts, with the reason its comment gives, whitespace collapsed. A lint
 * directive yields one `rule` entry per rule it names, and one with rule `*`
 * when it names none; its reason is the text after ` -- `. A lint config
 * yields one `config` entry per rule it switches off or down to a warning,
 * for each glob it does so for.
 */
export type Suppression =
  | {
      kind: "rule";
      rule: string;
      directive: string;
      reason: string;
      file: string;
      line: number;
    }
  | {
      kind: "config";
      rule: string;
      scope: string;
      file: string;
      line: number;
    }
  | {
      kind: "tsExpectError" | "tsIgnore" | "safety";
      reason: string;
      file: string;
      line: number;
    };

/** A block `oxlint-disable` or `eslint-disable` that no later `-enable` closes for `rule` (`*` for a blanket block). */
export interface OpenDisable {
  rule: string;
  directive: string;
  file: string;
  line: number;
}

/** Suppression totals: lint directives per named rule (`*` for none), each comment kind, then lint config rule-offs per rule; a budget adopted before config rule-offs were counted has no `config`. */
export interface SuppressionCounts {
  rules: Record<string, number>;
  tsExpectError: number;
  tsIgnore: number;
  safety: number;
  config?: Record<string, number>;
}

/** A comment without its delimiters, whether it is a line comment, and its offset in the file. */
interface CommentText {
  value: string;
  line: boolean;
  start: number;
}

const CODE_FILE = /\.(?:[cm]?[jt]sx?|vue)$/u;
const CANDIDATE = /(?:oxlint|eslint)-disable|@ts-(?:expect-error|ignore)/u;
const LINT_DIRECTIVE =
  /^((?:oxlint|eslint)-disable(?:-line|-next-line)?)(?=\s|$)([\s\S]*)$/u;
const DESCRIPTION = /\s-{2,}\s|\s-{2,}$/u;
/** The comment `anti-slop/require-safety-comment-for-type-assertion` accepts as a justification. */
const SAFETY_COMMENT = markerPattern(DEFAULT_SAFETY_MARKERS);
const TS_DIRECTIVE = /^[/*\s]*@ts-(expect-error|ignore)(?![\w-])/u;
const SAFETY_REASON = /SAFETY\s*:([\s\S]*)$/u;
const ENABLE_DIRECTIVE = /^((?:oxlint|eslint)-enable)(?=\s|$)([\s\S]*)$/u;

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

/** Collapses whitespace and the leading `*` of block comment lines. */
function normalized(text: string): string {
  return text
    .replaceAll(/\n\s*\*(?!\/)/gu, "\n")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

/** The rules a directive's text names, `*` for none, and the reason after its ` -- `. */
function directiveParts(rest: string) {
  const separator = DESCRIPTION.exec(rest);
  const rules = (separator === null ? rest : rest.slice(0, separator.index))
    .split(",")
    .map((rule) => rule.trim())
    .filter(Boolean);
  return {
    rules: rules.length ? rules : ["*"],
    reason:
      separator === null
        ? ""
        : normalized(rest.slice(separator.index + separator[0].length)),
  };
}

function lintDirective(value: string) {
  const text = value.replace(/^\s*\*?\s*/u, "");
  const directive = LINT_DIRECTIVE.exec(text);
  if (directive === null) return [];
  const { rules, reason } = directiveParts(directive[2]);
  return rules.map((rule) => ({ directive: directive[1], rule, reason }));
}

/** TypeScript reads a directive from a line comment, or from the last line of a block comment. */
function tsDirective(comment: CommentText) {
  const text = comment.line
    ? comment.value
    : comment.value.slice(comment.value.lastIndexOf("\n") + 1);
  const match = TS_DIRECTIVE.exec(text);
  if (match === null) return undefined;
  return {
    kind:
      match[1] === "ignore"
        ? ("tsIgnore" as const)
        : ("tsExpectError" as const),
    reason: normalized(text.slice(match[0].length)),
  };
}

/** Parsed comments by language and text, so a file unchanged between the base and the working tree is parsed once per run. */
const parsedComments = new Map<string, CommentText[]>();

function fileComments(file: string, text: string): CommentText[] {
  const language = file.endsWith(".vue")
    ? "vue"
    : file.slice(file.lastIndexOf(".") + 1);
  const key = `${language}\0${text}`;
  const cached = parsedComments.get(key);
  if (cached !== undefined) return cached;
  const comments = (
    language === "vue"
      ? vueComments(text)
      : scriptComments(text, scriptKind(language), 0)
  ).sort((a, b) => a.start - b.start);
  parsedComments.set(key, comments);
  return comments;
}

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

/** The suppressions in one code file's or lint config's text; `file` decides the language and labels each entry. */
export function suppressionsIn(file: string, text: string): Suppression[] {
  const found: Suppression[] = configRuleOffs(file, text).map(
    ({ rule, scope, line }) => ({ kind: "config", rule, scope, file, line }),
  );
  if (
    !CODE_FILE.test(file) ||
    !(CANDIDATE.test(text) || SAFETY_COMMENT.test(text))
  )
    return found;
  for (const comment of fileComments(file, text)) {
    const line = lineOf(text, comment.start);
    for (const { directive, rule, reason } of lintDirective(comment.value))
      found.push({ kind: "rule", rule, directive, reason, file, line });
    const typeDirective = tsDirective(comment);
    if (typeDirective !== undefined)
      found.push({ ...typeDirective, file, line });
    if (SAFETY_COMMENT.test(comment.value))
      found.push({
        kind: "safety",
        reason: normalized(SAFETY_REASON.exec(comment.value)?.[1] ?? ""),
        file,
        line,
      });
  }
  return found;
}

/**
 * The block disables in one code file's text that are still open at its end.
 * An `-enable` naming rules closes those rules; one naming none closes every
 * open block.
 */
export function openDisablesIn(file: string, text: string): OpenDisable[] {
  if (!CODE_FILE.test(file) || !CANDIDATE.test(text)) return [];
  const open = new Map<string, OpenDisable>();
  for (const comment of fileComments(file, text)) {
    const value = comment.value.replace(/^\s*\*?\s*/u, "");
    const disable = LINT_DIRECTIVE.exec(value);
    if (disable !== null && !disable[1].endsWith("line")) {
      const line = lineOf(text, comment.start);
      for (const rule of directiveParts(disable[2]).rules)
        open.set(rule, { rule, directive: disable[1], file, line });
      continue;
    }
    const enable = ENABLE_DIRECTIVE.exec(value);
    if (enable === null) continue;
    const { rules } = directiveParts(enable[2]);
    if (rules[0] === "*") open.clear();
    else for (const rule of rules) open.delete(rule);
  }
  return [...open.values()];
}

/** Each repository's generated-output test, remembered per path, since the base and the working tree list mostly the same files. */
const generatedPaths = new Map<string, (file: string) => boolean>();

function generatedIn(root: string): (file: string) => boolean {
  const known = generatedPaths.get(root);
  if (known !== undefined) return known;
  const test = generatedOutput(root);
  const verdicts = new Map<string, boolean>();
  const generated = (file: string) => {
    const verdict = verdicts.get(file) ?? test(file);
    verdicts.set(file, verdict);
    return verdict;
  };
  generatedPaths.set(root, generated);
  return generated;
}

function authoredCode(root: string, files: string[]): string[] {
  const generated = generatedIn(root);
  return files.filter(
    (file) =>
      (CODE_FILE.test(file) || LINT_CONFIG_FILE.test(file)) && !generated(file),
  );
}

/** What `read` finds in the working tree's authored code files and lint configs: tracked and untracked, ignored files and generated output left out. */
export function inWorktree<T>(
  root: string,
  read: (file: string, text: string) => T[],
  files = gitFiles(root),
): T[] {
  return authoredCode(root, files).flatMap((file) => {
    const path = join(root, file);
    if (!existsSync(path) || !lstatSync(path).isFile()) return [];
    return read(file, readFileSync(path, "utf8"));
  });
}

/** Suppressions in the working tree's authored code files. */
export function worktreeSuppressions(
  root: string,
  files = gitFiles(root),
): Suppression[] {
  return inWorktree(root, suppressionsIn, files);
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
 * What `read` finds in authored code files at a committed revision, or in the
 * index when `revision` is the empty string. Without `files` every file of
 * that tree is read.
 */
export function atRevision<T>(
  root: string,
  revision: string,
  read: (file: string, text: string) => T[],
  files?: string[],
): T[] {
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
    return text === undefined ? [] : read(file, text);
  });
}

/** Suppressions in authored code files at a committed revision, or in the index when `revision` is the empty string. */
export function revisionSuppressions(
  root: string,
  revision: string,
  files?: string[],
): Suppression[] {
  return atRevision(root, revision, suppressionsIn, files);
}

/** A count map with its keys sorted, so serialising it is stable. */
export function sortedKeys(
  counts: Record<string, number>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** Totals by budget key, rules and config rule-offs sorted by id. */
export function countSuppressions(
  suppressions: Suppression[],
): SuppressionCounts {
  const counts: SuppressionCounts = {
    rules: {},
    tsExpectError: 0,
    tsIgnore: 0,
    safety: 0,
  };
  const rules: Record<string, number> = {};
  const config: Record<string, number> = {};
  for (const suppression of suppressions) {
    if (suppression.kind === "rule")
      rules[suppression.rule] = (rules[suppression.rule] ?? 0) + 1;
    else if (suppression.kind === "config")
      config[suppression.rule] = (config[suppression.rule] ?? 0) + 1;
    else counts[suppression.kind]++;
  }
  return { ...counts, rules: sortedKeys(rules), config: sortedKeys(config) };
}
