import { type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { matchesPath } from "./glob.ts";
import { spawnLaunched } from "./launch.ts";
import { stopwatch } from "./timing.ts";
import type { FormalCheck } from "./types.ts";
import { operatorEnv, type RunState, type Workspace } from "./workspace.ts";
import { relativeSlashed } from "./slash.ts";

const OUTPUT_LIMIT = 64 * 1024 * 1024;

/** The recorded outcome of one formal check in a run. */
export interface FormalResult {
  name: string;
  exitCode: number | null;
  violated: string[];
  folder: string;
  /** Milliseconds the run took; absent in a result an older version wrote. */
  ms?: number;
}

/** What a check's run says: HOLDS when it exits 0 with no violated rule, VIOLATED when it reports one, ERROR when it exits non-zero without one. */
export interface FormalOutcome {
  status: "HOLDS" | "VIOLATED" | "ERROR";
  outcome: string;
}

function changesCheckFiles(check: FormalCheck, changed: string[]): boolean {
  return changed.some((file) =>
    (check.files ?? []).some((glob) => matchesPath(file, glob)),
  );
}

/** The formal checks of verify.config.ts whose covered files or own `files` the change touches. */
export function touchedFormalChecks(
  workspace: Workspace,
  changed: string[],
): FormalCheck[] {
  return (workspace.config.formal ?? []).filter(
    (check) =>
      changed.some((file) => check.covers.includes(file)) ||
      changesCheckFiles(check, changed),
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

function runCommand(command: string[], cwd: string): SpawnSyncReturns<string> {
  const [program, ...args] = command;
  return spawnLaunched(program, args, {
    cwd,
    env: operatorEnv(),
    encoding: "utf8",
    maxBuffer: OUTPUT_LIMIT,
  });
}

function writeRun(
  folder: string,
  command: string[],
  run: SpawnSyncReturns<string>,
): void {
  writeFileSync(join(folder, "command.txt"), `${command.join(" ")}\n`);
  writeFileSync(join(folder, "stdout.txt"), run.stdout ?? "");
  writeFileSync(
    join(folder, "stderr.txt"),
    `${run.stderr ?? ""}${run.error ? `\n${run.error.message}\n` : ""}`,
  );
  writeFileSync(join(folder, "exit-code.txt"), `${run.status}\n`);
}

/**
 * Runs one formal check from the repository root and writes its command,
 * output, exit code and violated rules under `evidence/formal/<name>/`.
 */
export function runFormalCheck(
  workspace: Workspace,
  state: RunState,
  check: FormalCheck,
): FormalResult {
  const elapsed = stopwatch();
  const folder = join(state.evidence, "formal", check.name);
  mkdirSync(folder, { recursive: true });
  const run = runCommand(check.command, workspace.root);
  writeRun(folder, check.command, run);
  const result: FormalResult = {
    name: check.name,
    exitCode: run.status,
    violated: violatedRules(check, run.status, run.stdout ?? ""),
    folder: relativeSlashed(state.evidence, folder),
    ms: elapsed(),
  };
  writeFileSync(
    join(folder, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  return result;
}

/** Reads a recorded result as HOLDS, VIOLATED or ERROR. */
export function formalOutcome(result: FormalResult): FormalOutcome {
  if (result.violated.length > 0)
    return {
      status: "VIOLATED",
      outcome: `violated ${result.violated.join(", ")} (exit ${result.exitCode})`,
    };
  if (result.exitCode !== 0)
    return { status: "ERROR", outcome: `tool error (exit ${result.exitCode})` };
  return { status: "HOLDS", outcome: "no violated rule (exit 0)" };
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
