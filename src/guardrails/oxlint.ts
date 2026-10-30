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

function parseReport(text: string): OxlintDiagnostic[] {
  /* SAFETY: this is oxlint's own -f json report; lintDiagnostics rejects any diagnostic without a plugin(rule) code. */
  const report = JSON.parse(text) as OxlintReport | null;
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
    if (result.status !== 0 && diagnostics.length === 0)
      throw new Error(
        `oxlint failed without diagnostics: ${result.stderr || result.stdout}`,
      );
    return diagnostics;
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

export function lintDiagnostics(
  root: string,
  config?: string,
  files?: string[],
): Diagnostic[] {
  return runOxlint(root, config, files, []).map((item) =>
    toDiagnostic(item, root),
  );
}

/** A lint directive oxlint reports as suppressing nothing: the rules it names as dead, or none named when the whole directive is dead. */
export interface UnusedDirective {
  file: string;
  line: number;
  message: string;
  rules: string[] | undefined;
}

const UNUSED_RULES = /\(no problems were reported from (.+)\)/u;

/**
 * The disable directives in `files` that suppress nothing, with every ratchet
 * rule enabled as in a measurement. `files` must not be empty, which would
 * lint the whole repository.
 */
export function unusedDirectives(
  root: string,
  files: string[],
): UnusedDirective[] {
  return runOxlint(root, undefined, files, [
    "--report-unused-disable-directives",
  ])
    .filter(
      ({ code, message }) =>
        code === undefined &&
        message.startsWith("Unused ") &&
        message.includes("-disable directive"),
    )
    .map((item) => ({
      file: repositoryPath(root, item.filename),
      line: item.labels?.[0]?.span.line ?? 0,
      message: item.message,
      rules: UNUSED_RULES.exec(item.message)?.[1].split(/,\s*/u),
    }));
}
