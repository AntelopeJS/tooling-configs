import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";

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
 * The disable directives in `files` that suppress nothing and the files
 * oxlint could not read.
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
    const file =
      item.filename === undefined
        ? undefined
        : repositoryPath(root, item.filename);
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
