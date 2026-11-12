import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { matchesPath } from "./glob.ts";
import { spawnLaunched } from "./launch.ts";
import {
  behaviourChange,
  inWorktree,
  type BehaviourChange,
  type Commits,
} from "./behaviour.ts";
import { stopwatch } from "./timing.ts";
import type { FormalCheck } from "./types.ts";
import { operatorEnv, type RunState, type Workspace } from "./workspace.ts";
import { relativeSlashed } from "./slash.ts";

const OUTPUT_LIMIT = 64 * 1024 * 1024;

/** Each violated rule whose counterexample length every line naming it gave as the same safe integer, written in decimal digits in a `states` group other than the rule's own group. */
type Lengths = Readonly<Record<string, number>>;

/** The rules a run of the check reported as broken and as holding. */
interface Rules {
  exitCode: number | null;
  violated: string[];
  passing: string[];
  lengths: Lengths;
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
  lengths?: Lengths;
  folder: string;
  commits?: Commits;
  behaviour?: BehaviourChange;
  checkChanged?: boolean;
  /** True when the diff adds the check: the base run failed, the base's verify.config.ts never names it, and none of its files is a rename of a base file. */
  newCheck?: boolean;
  base?: BaseRun | null;
  fixed?: string[];
  missing?: string[];
  /** Milliseconds the head run and, when it ran, the base run took; absent in a result an older version wrote. */
  ms?: number;
}

/** How a result weighs on a verdict whose diff the check covers. */
export interface FormalGate {
  fails: boolean;
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

function passingRules(
  check: FormalCheck,
  exitCode: number | null,
  output: string,
): string[] {
  if (check.passing)
    return [
      ...new Set([...output.matchAll(check.passing)].map((match) => match[1])),
    ];
  return !check.violation && exitCode === 0 ? ["property"] : [];
}

function withIndices(pattern: RegExp): RegExp {
  return pattern.hasIndices
    ? pattern
    : new RegExp(pattern.source, `${pattern.flags}d`);
}

function counterexampleLengths(check: FormalCheck, output: string): Lengths {
  if (!check.violation) return {};
  const seen = new Map<string, number | null>();
  for (const match of output.matchAll(withIndices(check.violation))) {
    const states = match.groups?.states;
    const rule = match[1];
    const statesIsRule =
      match.indices?.[1]?.[0] === match.indices?.groups?.states?.[0];
    const length =
      states === undefined || !/^\d+$/.test(states) || statesIsRule
        ? null
        : Number(states);
    seen.set(rule, seen.has(rule) && seen.get(rule) !== length ? null : length);
  }
  return Object.fromEntries(
    [...seen].filter(
      (entry): entry is [string, number] =>
        entry[1] !== null && Number.isSafeInteger(entry[1]),
    ),
  );
}

function rulesOf(check: FormalCheck, run: SpawnSyncReturns<string>): Rules {
  return {
    exitCode: run.status,
    violated: violatedRules(check, run.status, run.stdout ?? ""),
    passing: passingRules(check, run.status, run.stdout ?? ""),
    lengths: counterexampleLengths(check, run.stdout ?? ""),
  };
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

function gitOutput(root: string, args: string[]): string | null {
  const run = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: OUTPUT_LIMIT,
  });
  return run.status === 0 ? run.stdout : null;
}

function namedOnBase(
  workspace: Workspace,
  check: FormalCheck,
  baseSha: string,
): boolean {
  const config = relativeSlashed(
    workspace.root,
    join(workspace.skill, "verify.config.ts"),
  );
  const text = gitOutput(workspace.root, ["show", `${baseSha}:${config}`]);
  if (text === null) return false;
  return ['"', "'", "`"].some((quote) =>
    text.includes(`${quote}${check.name}${quote}`),
  );
}

function renamedFromBase(
  root: string,
  check: FormalCheck,
  diff: FormalDiff,
): boolean {
  const fields = (
    gitOutput(root, [
      "diff",
      "-M",
      "--name-status",
      "-z",
      diff.baseSha,
      diff.headSha,
    ]) ?? ""
  ).split("\0");
  return fields.some(
    (field, index) =>
      field.startsWith("R") &&
      (check.files ?? []).some((glob) =>
        matchesPath(fields[index + 2] ?? "", glob),
      ),
  );
}

/**
 * Whether the diff adds the check: the base could not run it, its name
 * appears nowhere in the base's verify.config.ts, and no file of its own
 * `files` is a rename of a base file. A moved or renamed check, or one whose
 * base ran, is a changed check, gated against the base.
 */
function addedByDiff(
  workspace: Workspace,
  check: FormalCheck,
  diff: FormalDiff,
  base: BaseRun,
): boolean {
  return (
    base.exitCode !== 0 &&
    !namedOnBase(workspace, check, diff.baseSha) &&
    !renamedFromBase(workspace.root, check, diff)
  );
}

function gateFields(
  workspace: Workspace,
  check: FormalCheck,
  diff: FormalDiff,
  folder: string,
  head: Rules,
): Partial<FormalResult> {
  const behaviour = behaviourChange(workspace.root, check, diff);
  const checkChanged = changesCheckFiles(check, diff.changed);
  if (!behaviour.changed && !checkChanged)
    return { behaviour, checkChanged, base: null, fixed: [], missing: [] };
  const base = baseRun(workspace, check, diff.baseSha, folder);
  const atHead = new Set([...head.violated, ...head.passing]);
  return {
    behaviour,
    checkChanged,
    newCheck: checkChanged && addedByDiff(workspace, check, diff, base),
    base,
    fixed: base.violated.filter(
      (rule) => head.passing.includes(rule) && !head.violated.includes(rule),
    ),
    missing: base.violated.filter((rule) => !atHead.has(rule)),
  };
}

/**
 * Runs one formal check from the repository root and writes its command,
 * output, exit code, violated rules and their counterexample lengths under
 * `evidence/formal/<name>/`.
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
  const elapsed = stopwatch();
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
    lengths: head.lengths,
    folder: relativeSlashed(state.evidence, folder),
  };
  if (diff !== null)
    Object.assign(
      result,
      { commits: { baseSha: diff.baseSha, headSha: diff.headSha } },
      gateFields(workspace, check, diff, folder, head),
    );
  result.ms = elapsed();
  writeFileSync(
    join(folder, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  return result;
}

function lengthOf(lengths: Lengths | undefined, rule: string) {
  return lengths !== undefined && Object.hasOwn(lengths, rule)
    ? lengths[rule]
    : undefined;
}

function knownFindingsOfBase(result: FormalResult): boolean {
  const { base } = result;
  if (!base || base.exitCode !== 0) return false;
  const atHead = new Set(result.violated);
  const fixed = new Set(result.fixed ?? []);
  return (
    base.violated.every((rule) => atHead.has(rule) || fixed.has(rule)) &&
    result.violated.every((rule) => {
      const length = lengthOf(result.lengths, rule);
      return (
        base.violated.includes(rule) &&
        length !== undefined &&
        length === lengthOf(base.lengths, rule)
      );
    })
  );
}

/**
 * The outcome a result's base run forces before the findings are weighed: a
 * check the diff adds, on a diff that leaves the covered behaviour unchanged,
 * passes its recorded findings, since its record is reviewed with it and the
 * base has nothing to compare, and fails with the advice to land it alone when
 * the covered code changed too; otherwise a failure
 * for a changed check with no base run recorded, a base run that exited non-zero
 * while HEAD breaks rules, or, when the covered behaviour is unchanged, a rule
 * HEAD breaks that the base did not. `null` when the base decides nothing.
 */
function baseGate(result: FormalResult): FormalGate | null {
  const { base, behaviour } = result;
  if (
    result.newCheck === true &&
    base &&
    base.exitCode !== 0 &&
    behaviour?.changed === false
  )
    return {
      fails: false,
      outcome: `new check, absent from the base: ${result.violated.length > 0 ? `recorded findings ${result.violated.join(", ")}` : "no violated rule"}`,
    };
  if (
    result.newCheck === true &&
    behaviour?.changed === true &&
    result.violated.length > 0
  )
    return {
      fails: true,
      outcome:
        "new check with a covered-code change: land the check in its own PR first",
    };
  if (result.checkChanged === true && !base)
    return {
      fails: true,
      outcome: "the check's own files changed but no base run was recorded",
    };
  if (!base) return null;
  if (base.exitCode !== 0 && result.violated.length > 0)
    return {
      fails: true,
      outcome: `the base run exited ${base.exitCode}, so ${result.violated.join(", ")} cannot be compared with the base`,
    };
  const added = result.violated.filter((rule) => !base.violated.includes(rule));
  if (behaviour?.changed === false && added.length > 0)
    return {
      fails: true,
      outcome: `covered behaviour unchanged (${behaviour.method}), but the check breaks rules the base did not: ${added.join(", ")}`,
    };
  return null;
}

/**
 * How a formal check's result weighs on a verdict whose diff it covers. A
 * non-zero exit (a tool error, or a check that no longer matches its record)
 * fails, so every violated rule of a result that reaches the rest of the gate
 * is a recorded finding. A rule the base broke that HEAD does not report at
 * all fails. A base run that exited non-zero cannot vouch for HEAD's findings,
 * and a changed check with no base run recorded fails. A check the diff adds
 * (the base could not run it, never names it and holds none of its files
 * under another path) passes its recorded findings when the covered
 * behaviour is unchanged. Otherwise, when the covered behaviour is unchanged,
 * recorded findings are known, except a rule HEAD breaks that the base run
 * did not, which fails whatever the diff touched. When the behaviour
 * changed, they are known only when the base run exited 0 and broke every
 * one of them, each with the same counterexample length at HEAD as on the
 * base, and every other rule the base broke is fixed at HEAD; a new rule, a
 * changed length, or a length either run did not report fails. A rule the
 * base broke and HEAD reports passing is reported as fixed.
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
  const againstBase = baseGate(result);
  if (againstBase) return againstBase;
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
  if (knownFindingsOfBase(result))
    return {
      fails: false,
      outcome: `covered behaviour changed (${how}), same known findings as base: ${result.violated.join(", ")}${fixed}`,
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
