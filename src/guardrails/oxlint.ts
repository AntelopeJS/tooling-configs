import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";

import { docsPointer, ruleDocPath } from "../oxc/rule-docs.ts";
import { repositoryPath } from "./files.ts";

function resolveOxlint(root: string): string {
  try {
    const require = createRequire(join(root, "package.json"));
    return join(dirname(require.resolve("oxlint/package.json")), "bin/oxlint");
  } catch {
    throw new Error(
      "oxlint is not installed in this repository. Install dependencies first.",
    );
  }
}

interface OxlintSpan {
  line: number;
  column: number;
}

interface OxlintDiagnostic {
  code?: string;
  /** Absent when oxlint could not open the file, as for one that is not UTF-8; the message names the path. */
  filename?: string;
  message: string;
  help?: string;
  /** The page oxlint documents a built-in rule on. */
  url?: string;
  severity?: "error" | "warning" | "advice";
  labels?: { span: OxlintSpan }[];
}

interface OxlintReport {
  diagnostics: OxlintDiagnostic[];
}

const NO_FILES = "No files found to lint.";
const PLUGIN_ERROR = "Error running JS plugin.";

/** Whether oxlint matched no file, in which case it prints a notice before its report and exits 1. */
function foundNoFiles(stdout: string): boolean {
  return stdout.startsWith(NO_FILES) && stdout.includes("{");
}

/** The `-f json` report in oxlint's stdout, or undefined when oxlint printed an error in its place. */
function parseReport(text: string): OxlintDiagnostic[] | undefined {
  const json = foundNoFiles(text) ? text.slice(text.indexOf("{")) : text;
  if (!json.startsWith("{")) return undefined;
  /* SAFETY: this is oxlint's own -f json report; the diagnostics array is checked before it is returned. */
  const report = JSON.parse(json) as OxlintReport | null;
  if (!Array.isArray(report?.diagnostics))
    throw new Error("oxlint did not return a JSON diagnostics array.");
  return report.diagnostics;
}

function runOxlint(
  root: string,
  config: string | undefined,
  files: string[] | undefined,
  flags: string[],
): OxlintDiagnostic[] {
  const binary = resolveOxlint(root);
  const temporary =
    config === undefined
      ? undefined
      : mkdtempSync(join(root, ".antelopejs-measure.generated."));
  try {
    const args = [binary, "-f", "json", ...flags];
    if (temporary) {
      const path = join(temporary, "oxlint.config.ts");
      writeFileSync(path, config ?? "");
      args.push(
        "--config",
        path,
        "--ignore-pattern",
        `${basename(temporary)}/**`,
      );
    }
    if (files) args.push("--no-error-on-unmatched-pattern", "--", ...files);
    const result = spawnSync(process.execPath, args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1)
      throw new Error(
        `oxlint failed (${result.status ?? result.signal}): ${result.stderr || result.stdout}`,
      );
    const diagnostics = parseReport(result.stdout);
    if (diagnostics === undefined)
      throw new Error(
        `oxlint failed (exit ${result.status}): ${result.stdout}${result.stderr}`.trimEnd(),
      );
    if (
      result.status !== 0 &&
      diagnostics.length === 0 &&
      !foundNoFiles(result.stdout)
    )
      throw new Error(
        `oxlint failed without diagnostics: ${result.stderr || result.stdout}`,
      );
    const crash = diagnostics.find(
      ({ code, message }) =>
        code === undefined && message.startsWith(PLUGIN_ERROR),
    );
    if (crash) throw new Error(crash.message);
    return diagnostics;
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

/** One entry of `oxlint --rules -f json`. */
interface OxlintRule {
  scope: string;
  value: string;
  type_aware: boolean;
}

function isOxlintRule(value: unknown): value is OxlintRule {
  return (
    typeof value === "object" &&
    value !== null &&
    "scope" in value &&
    typeof value.scope === "string" &&
    "value" in value &&
    typeof value.value === "string" &&
    "type_aware" in value &&
    typeof value.type_aware === "boolean"
  );
}

/** The `scope/name` of every rule oxlint runs only with type information. */
export function typeAwareRules(root: string): Set<string> {
  const result = spawnSync(
    process.execPath,
    [resolveOxlint(root), "--rules", "-f", "json"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `oxlint --rules failed (${result.status ?? result.signal}): ${result.stderr || result.stdout}`,
    );
  const rules: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(rules) || !rules.every(isOxlintRule))
    throw new Error("oxlint --rules did not return a JSON array of rules.");
  return new Set(
    rules
      .filter((rule) => rule.type_aware)
      .map((rule) => `${rule.scope}/${rule.value}`),
  );
}

/** A lint directive oxlint reports as suppressing nothing: the rules it names as dead, or none named when the whole directive is dead. */
export interface UnusedDirective {
  file: string;
  line: number;
  message: string;
  rules: string[] | undefined;
}

/** An error oxlint reports with no rule code, such as a parse error or a file it cannot open, so the file's directives went unchecked. */
interface UnreadableFile {
  /** `file:line:column` of the first label, the file when oxlint gives no span, or undefined when it names no file outside the message. */
  location: string | undefined;
  message: string;
}

/** A tsconfig oxlint cannot load, so it ran no type-aware rule on the files it covers. */
export interface UntypedConfig {
  tsconfig: string;
  reason: string;
}

/** What oxlint reports about the directives in a set of files. */
export interface DirectiveReport {
  unused: UnusedDirective[];
  unreadable: UnreadableFile[];
  untyped: UntypedConfig[];
}

const TSCONFIG_ERROR = "typescript(tsconfig-error)";

const UNUSED_RULES = /\(no problems were reported from (.+)\)/u;

function isUnusedDirective(message: string): boolean {
  return (
    message.startsWith("Unused ") && message.includes("-disable directive")
  );
}

/**
 * The disable directives in `files` that suppress nothing and the files
 * oxlint could not read.
 * `files` must not be empty, which would lint the whole repository.
 */
export function directiveReport(
  root: string,
  files: string[],
): DirectiveReport {
  const report: DirectiveReport = { unused: [], unreadable: [], untyped: [] };
  for (const item of runOxlint(root, undefined, files, [
    "--report-unused-disable-directives",
  ])) {
    const file =
      item.filename === undefined
        ? undefined
        : repositoryPath(root, item.filename);
    if (item.code === TSCONFIG_ERROR && file !== undefined)
      report.untyped.push({
        tsconfig: file,
        reason: item.help ?? item.message,
      });
    if (item.code !== undefined) continue;
    const span = item.labels?.[0]?.span;
    if (file !== undefined && isUnusedDirective(item.message))
      report.unused.push({
        file,
        line: span?.line ?? 0,
        message: item.message,
        rules: UNUSED_RULES.exec(item.message)?.[1].split(/,\s*/u),
      });
    else
      report.unreadable.push({
        location:
          file !== undefined && span
            ? `${file}:${span.line}:${span.column}`
            : file,
        message: item.message,
      });
  }
  return report;
}

/** What the commit hook prints after linting the staged files. */
interface StagedLintReport {
  /** One line per tsconfig that cannot load, whose files were linted without type information. */
  skipped: string[];
  /** Every other diagnostic, one `file:line:column: code: message` line each. */
  findings: string[];
  /** Whether any of the findings is an error. */
  failed: boolean;
}

/**
 * Lints `files` as configured, reporting a tsconfig that cannot load, such as
 * one extending generated types not built yet, as skipped rather than failed:
 * oxlint still runs its other rules on the files it covers, and CI, which
 * builds first, runs the type-aware ones.
 */
export function lintStaged(root: string, files: string[]): StagedLintReport {
  const report: StagedLintReport = { skipped: [], findings: [], failed: false };
  if (files.length === 0) return report;
  for (const item of runOxlint(root, undefined, files, [])) {
    const file =
      item.filename === undefined
        ? undefined
        : repositoryPath(root, item.filename);
    if (item.code === TSCONFIG_ERROR) {
      report.skipped.push(
        `${file} cannot load (${item.help ?? item.message}), so the staged files it covers were linted without type information; CI lints them with it.`,
      );
      continue;
    }
    const span = item.labels?.[0]?.span;
    const location = span ? `${file}:${span.line}:${span.column}` : file;
    const help = item.help === undefined ? "" : ` ${item.help}`;
    report.findings.push(
      `${location === undefined ? "" : `${location}: `}${item.code ?? "error"}: ${item.message}${help}`,
    );
    if (item.severity !== "warning" && item.severity !== "advice")
      report.failed = true;
  }
  return report;
}

/** One diagnostic of a lint run, parsed once for the summary's three blocks. */
interface Finding {
  file: string | undefined;
  line: number;
  column: number;
  /** `file:line:column`, the file alone without a span, or undefined without a file. */
  location: string | undefined;
  /** `plugin/name`, or `oxlint` for a diagnostic with no rule, such as a parse error. */
  rule: string;
  message: string;
  /** The page that documents the rule, when the message or oxlint names one. */
  doc: string | undefined;
  failing: boolean;
}

/** What `antelopejs-lint-summary` prints and whether any finding is an error. */
interface LintSummary {
  lines: string[];
  failed: boolean;
}

const RULE_CODE = /^(?<plugin>[^(]+)\((?<name>.+)\)$/u;

function oneLine(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

interface RuleParts {
  rule: string;
  name?: string;
}

interface DocumentedMessage {
  message: string;
  doc: string | undefined;
}

/** The `plugin/name` of an oxlint `plugin(name)` code and the bare `name`, or `oxlint` for a diagnostic with no rule. */
function ruleOf(code: string | undefined): RuleParts {
  const parts = code === undefined ? null : RULE_CODE.exec(code);
  const name = parts?.groups?.name;
  if (name === undefined) return { rule: code ?? "oxlint" };
  return { rule: `${parts?.groups?.plugin}/${name}`, name };
}

/** The message without the docs pointer of rule `name`, with the page the pointer names, or the page oxlint gives. */
function documented(
  item: OxlintDiagnostic,
  name: string | undefined,
): DocumentedMessage {
  const pointer = name === undefined ? "" : docsPointer(name);
  if (name === undefined || !item.message.endsWith(pointer))
    return { message: item.message, doc: item.url };
  return {
    message: item.message.slice(0, -pointer.length),
    doc: ruleDocPath(name),
  };
}

function toFinding(root: string, item: OxlintDiagnostic): Finding {
  const file =
    item.filename === undefined
      ? undefined
      : repositoryPath(root, item.filename);
  const span = item.labels?.[0]?.span;
  const { rule, name } = ruleOf(item.code);
  const { message, doc } = documented(item, name);
  const help = item.help === undefined ? "" : ` ${item.help}`;
  return {
    file,
    line: span?.line ?? 0,
    column: span?.column ?? 0,
    location:
      span && file !== undefined ? `${file}:${span.line}:${span.column}` : file,
    rule,
    message: oneLine(`${message}${help}`),
    doc,
    failing: item.severity !== "warning" && item.severity !== "advice",
  };
}

function compareFindings(a: Finding, b: Finding): number {
  return (
    (a.file ?? "").localeCompare(b.file ?? "") ||
    a.line - b.line ||
    a.column - b.column
  );
}

/** `key`s of `findings` with their counts and the first `doc` seen, most frequent first, then by name. */
function countBy(
  findings: Finding[],
  key: (finding: Finding) => string | undefined,
): { name: string; count: number; doc: string | undefined }[] {
  const counts = new Map<string, { count: number; doc: string | undefined }>();
  for (const finding of findings) {
    const name = key(finding);
    if (name === undefined) continue;
    const entry = counts.get(name) ?? { count: 0, doc: finding.doc };
    entry.count += 1;
    counts.set(name, entry);
  }
  return [...counts]
    .map(([name, { count, doc }]) => ({ name, count, doc }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Lints `files`, or the repository as configured when none are named, and
 * summarises it as one line per finding sorted by file, line and column, then
 * the count per rule with the page that documents it, then the count per file,
 * the blocks separated by one blank line. No finding gives no line.
 */
export function lintSummary(root: string, files: string[]): LintSummary {
  const findings = runOxlint(
    root,
    undefined,
    files.length === 0 ? undefined : files,
    [],
  )
    .map((item) => toFinding(root, item))
    .sort(compareFindings);
  if (findings.length === 0) return { lines: [], failed: false };
  const rules = countBy(findings, ({ rule }) => rule).map(
    ({ name, count, doc }) =>
      `${count} ${name}${doc === undefined ? "" : ` ${doc}`}`,
  );
  const perFile = countBy(findings, ({ file }) => file).map(
    ({ name, count }) => `${count} ${name}`,
  );
  const lines = [
    ...findings.map(
      ({ location, rule, message }) =>
        `${location === undefined ? "" : `${location} `}${rule} ${message}`,
    ),
    "",
    ...rules,
  ];
  if (perFile.length > 0) lines.push("", ...perFile);
  return { lines, failed: findings.some(({ failing }) => failing) };
}
