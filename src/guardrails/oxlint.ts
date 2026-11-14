import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";

import { MEASURE_ENV } from "./ceilings.ts";
import { repositoryPath } from "./files.ts";

export interface Diagnostic {
  rule: string;
  file: string;
  /** `file:line:column` of the first label, or the file when oxlint gives no span. */
  location: string;
  message: string;
  line: number | undefined;
  help: string | undefined;
}

const TSCONFIG_ERROR = "typescript/tsconfig-error";

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

function ruleId(code: string): string {
  const match = /^([^()]+)\(([^()]+)\)$/.exec(code);
  if (!match)
    throw new Error(
      `Cannot measure oxlint diagnostic code ${JSON.stringify(code)}. Fix parser or configuration errors before recording a baseline.`,
    );
  const [, plugin, rule] = match;
  return `${plugin === "typescript-eslint" ? "typescript" : plugin}/${rule}`;
}

interface OxlintSpan {
  line: number;
  column: number;
}

interface OxlintDiagnostic {
  code?: string;
  filename: string;
  message: string;
  help?: string;
  labels?: { span: OxlintSpan }[];
}

interface OxlintReport {
  diagnostics: OxlintDiagnostic[];
}

const NO_FILES = "No files found to lint.";

/** Whether oxlint matched no file, in which case it prints a notice before its report and exits 1. */
function foundNoFiles(stdout: string): boolean {
  return stdout.startsWith(NO_FILES) && stdout.includes("{");
}

/** The `-f json` report in oxlint's stdout, or undefined when oxlint printed an error in its place. */
function parseReport(text: string): OxlintDiagnostic[] | undefined {
  const json = foundNoFiles(text) ? text.slice(text.indexOf("{")) : text;
  if (!json.startsWith("{")) return undefined;
  /* SAFETY: this is oxlint's own -f json report; lintDiagnostics rejects any diagnostic without a plugin(rule) code. */
  const report = JSON.parse(json) as OxlintReport | null;
  if (!Array.isArray(report?.diagnostics))
    throw new Error("oxlint did not return a JSON diagnostics array.");
  return report.diagnostics;
}

function toDiagnostic(item: OxlintDiagnostic, root: string): Diagnostic {
  const file = repositoryPath(root, item.filename);
  const span = item.labels?.[0]?.span;
  return {
    rule: ruleId(item.code ?? ""),
    file,
    location: span ? `${file}:${span.line}:${span.column}` : file,
    message: item.message,
    line: span?.line,
    help: item.help,
  };
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
      env: { ...process.env, [MEASURE_ENV]: "1" },
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
    return diagnostics;
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

export interface LintOptions {
  /** Throws when a TypeScript project fails to load, whose type-aware rules would otherwise read as zero findings. */
  rejectBrokenProject?: boolean;
}

export function lintDiagnostics(
  root: string,
  config?: string,
  files?: string[],
  { rejectBrokenProject = false }: LintOptions = {},
): Diagnostic[] {
  const diagnostics = runOxlint(root, config, files, []).map((item) =>
    toDiagnostic(item, root),
  );
  const broken = rejectBrokenProject
    ? diagnostics.find(({ rule }) => rule === TSCONFIG_ERROR)
    : undefined;
  if (broken)
    throw new Error(
      `${broken.location}: ${broken.message}${broken.help ? ` ${broken.help}` : ""}. The type-aware rules cannot be measured until the TypeScript project loads.`,
    );
  return diagnostics;
}

/** A lint directive oxlint reports as suppressing nothing: the rules it names as dead, or none named when the whole directive is dead. */
export interface UnusedDirective {
  file: string;
  line: number;
  message: string;
  rules: string[] | undefined;
}

/** An error oxlint reports with no rule code, such as a parse error: oxlint could not read the file, so its directives went unchecked. */
export interface UnreadableFile {
  /** `file:line:column` of the first label, or the file when oxlint gives no span. */
  location: string;
  message: string;
}

/** What oxlint reports about the directives in a set of files. */
export interface DirectiveReport {
  unused: UnusedDirective[];
  unreadable: UnreadableFile[];
}

const UNUSED_RULES = /\(no problems were reported from (.+)\)/u;

function isUnusedDirective(message: string): boolean {
  return (
    message.startsWith("Unused ") && message.includes("-disable directive")
  );
}

/**
 * The disable directives in `files` that suppress nothing, with every ratchet
 * rule enabled as in a measurement, and the files oxlint could not read.
 * `files` must not be empty, which would lint the whole repository.
 */
export function directiveReport(
  root: string,
  files: string[],
): DirectiveReport {
  const report: DirectiveReport = { unused: [], unreadable: [] };
  for (const item of runOxlint(root, undefined, files, [
    "--report-unused-disable-directives",
  ])) {
    if (item.code !== undefined) continue;
    const file = repositoryPath(root, item.filename);
    const span = item.labels?.[0]?.span;
    if (isUnusedDirective(item.message))
      report.unused.push({
        file,
        line: span?.line ?? 0,
        message: item.message,
        rules: UNUSED_RULES.exec(item.message)?.[1].split(/,\s*/u),
      });
    else
      report.unreadable.push({
        location: span ? `${file}:${span.line}:${span.column}` : file,
        message: item.message,
      });
  }
  return report;
}
