import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import type { FormalCheck } from "./types.ts";
import type { RunState, Workspace } from "./workspace.ts";

/** The recorded outcome of one formal check in a run. */
export interface FormalResult {
  name: string;
  exitCode: number | null;
  violated: string[];
  folder: string;
}

/** The formal checks of verify.config.ts whose covered files the change touches. */
export function touchedFormalChecks(
  workspace: Workspace,
  changed: string[],
): FormalCheck[] {
  return (workspace.config.formal ?? []).filter((check) =>
    changed.some((file) => check.covers.includes(file)),
  );
}

function violatedRules(
  check: FormalCheck,
  exitCode: number | null,
  output: string,
): string[] {
  if (check.violation)
    return [
      ...new Set(
        [...output.matchAll(check.violation)].map((match) => match[1]),
      ),
    ];
  return exitCode === 0 ? [] : ["property"];
}

/** Runs one formal check from the repository root and records it under evidence/formal/<name>/. */
export function runFormalCheck(
  workspace: Workspace,
  state: RunState,
  check: FormalCheck,
): FormalResult {
  const folder = join(state.evidence, "formal", check.name);
  mkdirSync(folder, { recursive: true });
  const [program, ...args] = check.command;
  const run = spawnSync(program, args, {
    cwd: workspace.root,
    encoding: "utf8",
  });
  writeFileSync(join(folder, "command.txt"), `${check.command.join(" ")}\n`);
  writeFileSync(join(folder, "stdout.txt"), run.stdout ?? "");
  writeFileSync(
    join(folder, "stderr.txt"),
    `${run.stderr ?? ""}${run.error ? `\n${run.error.message}\n` : ""}`,
  );
  writeFileSync(join(folder, "exit-code.txt"), `${run.status}\n`);
  const result: FormalResult = {
    name: check.name,
    exitCode: run.status,
    violated: violatedRules(check, run.status, run.stdout ?? ""),
    folder: relative(state.evidence, folder),
  };
  writeFileSync(
    join(folder, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  return result;
}

/** The recorded result of a formal check in a run, if it ran. */
export function readFormalResult(
  state: RunState,
  name: string,
): FormalResult | undefined {
  const file = join(state.evidence, "formal", name, "result.json");
  if (!existsSync(file)) return undefined;
  const result: FormalResult = JSON.parse(readFileSync(file, "utf8"));
  return result;
}
