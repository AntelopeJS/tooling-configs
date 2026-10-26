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
  code: string;
  filename: string;
  message: string;
  help?: string;
  labels?: { span: OxlintSpan }[];
}

interface OxlintReport {
  diagnostics: OxlintDiagnostic[];
}

function parseDiagnostics(text: string, root: string): Diagnostic[] {
  /* SAFETY: this is oxlint's own -f json report; ruleId rejects any diagnostic without a plugin(rule) code. */
  const report = JSON.parse(text) as OxlintReport | null;
  if (!Array.isArray(report?.diagnostics))
    throw new Error("oxlint did not return a JSON diagnostics array.");
  return report.diagnostics.map((item) => {
    const file = repositoryPath(root, item.filename);
    const span = item.labels?.[0]?.span;
    return {
      rule: ruleId(item.code),
      file,
      location: span ? `${file}:${span.line}:${span.column}` : file,
      message: item.message,
      line: span?.line,
      help: item.help,
    };
  });
}

export function lintDiagnostics(
  root: string,
  config?: string,
  files?: string[],
): Diagnostic[] {
  const binary = resolveOxlint(root);
  const temporary =
    config === undefined
      ? undefined
      : mkdtempSync(join(root, ".antelopejs-measure.generated."));
  try {
    const args = [binary, "-f", "json"];
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
    const diagnostics = parseDiagnostics(result.stdout, root);
    if (result.status !== 0 && diagnostics.length === 0)
      throw new Error(
        `oxlint failed without diagnostics: ${result.stderr || result.stdout}`,
      );
    return diagnostics;
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
