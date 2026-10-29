import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, matchesGlob, relative } from "node:path";

import {
  behaviourChange,
  inWorktree,
  type BehaviourChange,
  type Commits,
} from "./behaviour.ts";
import type { FormalCheck } from "./types.ts";
import type { RunState, Workspace } from "./workspace.ts";

const OUTPUT_LIMIT = 64 * 1024 * 1024;

/** The rules a run of the check reported as broken and as holding. */
interface Rules {
  exitCode: number | null;
  violated: string[];
  passing: string[];
}

/** What the check reported on the base, when the covered behaviour or the check changed. */
type BaseRun = Rules;

/** The diff a covered check is gated on: its two commits and the files it changed. */
export interface FormalDiff extends Commits {
  changed: string[];
}

/** The recorded outcome of one formal check in a run; the gate fields are set when the check covers the diff. */
export interface FormalResult {
  name: string;
  exitCode: number | null;
  violated: string[];
  passing?: string[];
  folder: string;
  commits?: Commits;
  behaviour?: BehaviourChange;
  checkChanged?: boolean;
  base?: BaseRun | null;
  fixed?: string[];
  missing?: string[];
}

/** How a result weighs on a verdict whose diff the check covers. */
export interface FormalGate {
  fails: boolean;
  outcome: string;
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

function passingRules(check: FormalCheck, output: string): string[] {
  return check.passing
    ? [...new Set([...output.matchAll(check.passing)].map((match) => match[1]))]
    : [];
}

function rulesOf(check: FormalCheck, run: SpawnSyncReturns<string>): Rules {
  return {
    exitCode: run.status,
    violated: violatedRules(check, run.status, run.stdout ?? ""),
    passing: passingRules(check, run.stdout ?? ""),
  };
}

function runCommand(command: string[], cwd: string): SpawnSyncReturns<string> {
  const [program, ...args] = command;
  return spawnSync(program, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: OUTPUT_LIMIT,
  });
}

function writeRun(
  folder: string,
  prefix: string,
  command: string[],
  run: SpawnSyncReturns<string>,
): void {
  writeFileSync(join(folder, `${prefix}command.txt`), `${command.join(" ")}\n`);
  writeFileSync(join(folder, `${prefix}stdout.txt`), run.stdout ?? "");
  writeFileSync(
    join(folder, `${prefix}stderr.txt`),
    `${run.stderr ?? ""}${run.error ? `\n${run.error.message}\n` : ""}`,
  );
  writeFileSync(join(folder, `${prefix}exit-code.txt`), `${run.status}\n`);
}

function baseRun(
  workspace: Workspace,
  check: FormalCheck,
  baseSha: string,
  folder: string,
): BaseRun {
  const command = check.baseCommand ?? check.command;
  const run = inWorktree(workspace.root, baseSha, (dir) =>
    runCommand(command, dir),
  );
  writeRun(folder, "base-", command, run);
  return rulesOf(check, run);
}

function gateFields(
  workspace: Workspace,
  check: FormalCheck,
  diff: FormalDiff,
  folder: string,
  head: Rules,
): Partial<FormalResult> {
  const behaviour = behaviourChange(workspace.root, check, diff);
  const checkChanged = diff.changed.some((file) =>
    (check.files ?? []).some((glob) => matchesGlob(file, glob)),
  );
  if (!behaviour.changed && !checkChanged)
    return { behaviour, checkChanged, base: null, fixed: [], missing: [] };
  const base = baseRun(workspace, check, diff.baseSha, folder);
  const atHead = new Set([...head.violated, ...head.passing]);
  return {
    behaviour,
    checkChanged,
    base,
    fixed: base.violated.filter(
      (rule) => head.passing.includes(rule) && !head.violated.includes(rule),
    ),
    missing: base.violated.filter((rule) => !atHead.has(rule)),
  };
}

/**
 * Runs one formal check from the repository root and writes its command,
 * output, exit code and violated rules under `evidence/formal/<name>/`.
 * When the check covers the diff (`diff` given), it also records whether the
 * diff changed the covered code's behaviour. When it did, or when the diff
 * changed the check's own `files`, it runs the check on the base: `fixed`
 * lists the rules the base broke that HEAD reports passing, and `missing`
 * the rules the base broke that HEAD reports neither failing nor passing.
 */
export function runFormalCheck(
  workspace: Workspace,
  state: RunState,
  check: FormalCheck,
  diff: FormalDiff | null,
): FormalResult {
  const folder = join(state.evidence, "formal", check.name);
  mkdirSync(folder, { recursive: true });
  const run = runCommand(check.command, workspace.root);
  writeRun(folder, "", check.command, run);
  const head = rulesOf(check, run);
  const result: FormalResult = {
    name: check.name,
    exitCode: run.status,
    violated: head.violated,
    passing: head.passing,
    folder: relative(state.evidence, folder),
  };
  if (diff !== null)
    Object.assign(
      result,
      { commits: { baseSha: diff.baseSha, headSha: diff.headSha } },
      gateFields(workspace, check, diff, folder, head),
    );
  writeFileSync(
    join(folder, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  return result;
}

/**
 * How a formal check's result weighs on a verdict whose diff it covers. A
 * non-zero exit (a tool error, or a check that no longer matches its record)
 * fails. Recorded findings fail only when the diff changed the covered code's
 * behaviour; otherwise they are reported as known. A rule the base broke and
 * HEAD reports passing is reported as fixed; one HEAD does not report at all
 * fails.
 */
export function formalGate(result: FormalResult): FormalGate {
  if (result.exitCode !== 0) {
    const what =
      result.violated.length > 0
        ? `the check no longer matches its record: ${result.violated.join(", ")}`
        : "tool error";
    return { fails: true, outcome: `${what}, exit ${result.exitCode}` };
  }
  if ((result.missing ?? []).length > 0)
    return {
      fails: true,
      outcome: `rules the base broke are absent at HEAD: ${(result.missing ?? []).join(", ")}`,
    };
  if (result.behaviour === undefined)
    return {
      fails: result.violated.length > 0,
      outcome: `violated ${result.violated.join(", ") || "nothing"}`,
    };
  const how = result.behaviour.method;
  if (!result.behaviour.changed)
    return {
      fails: false,
      outcome: `covered behaviour unchanged (${how}): ${result.violated.length > 0 ? `known findings ${result.violated.join(", ")}` : "no violated rule"}`,
    };
  const fixed =
    (result.fixed ?? []).length > 0
      ? `; fixed: ${(result.fixed ?? []).join(", ")}`
      : "";
  if (result.violated.length === 0)
    return {
      fails: false,
      outcome: `covered behaviour changed (${how}), no violated rule${fixed}`,
    };
  return {
    fails: true,
    outcome: `covered behaviour changed (${how}), violated ${result.violated.join(", ")}${fixed}`,
  };
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
