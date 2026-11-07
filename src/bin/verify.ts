#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { runCliAsync } from "../guardrails/cli.ts";
import { repositoryRoot } from "../guardrails/files.ts";
import { doorLine, flaggedDoors, patchFiles } from "../verify/doors.ts";
import {
  formalGate,
  runFormalCheck,
  touchedFormalChecks,
} from "../verify/formal.ts";
import { readJudgement } from "../verify/judgement.ts";
import {
  isVerifyKind,
  skillFolder,
  VERIFY_KINDS,
  type VerifyKind,
} from "../verify/kinds.ts";
import { clean, createRun, doctor } from "../verify/lifecycle.ts";
import { checkMap, planFor } from "../verify/map.ts";
import { postComment, pushEvidence, setStatus } from "../verify/publish.ts";
import { knownJourneys, runFeature } from "../verify/runner.ts";
import type { JourneyResult } from "../verify/results.ts";
import { seconds } from "../verify/timing.ts";
import { renderVerdict } from "../verify/verdict.ts";
import { loadRun, openWorkspace, type Workspace } from "../verify/workspace.ts";

const USAGE = `Usage: antelopejs-verify <command>

  map                                check every user-facing file is covered and every feature is complete
  plan [--base <ref>] [--all]        map the diff to features; list unmapped surfaces; every feature runs when a shared file changed or with --all
  new [--base <ref>] [--title <t>] [--all]
                                     build, prepare an isolated run, print its folder; --all runs every feature, before a release
  doctor <run>                       check the run is worth driving
  journey <run> <feature> [ids...]   run a feature's journeys and record evidence
  journey <run> --plan               run every feature the run's plan lists, smoke first
  journey <run> --features <a,b>     run the named features, each whole, in that order
  formal <run> [--all]               run the formal checks that cover the diff and gate them on changed behaviour
  doors [patch] [--base <ref>]       print the One-way-door line for a patch, or for the diff
  clean <run>                        stop what the run started, keep only the evidence
  verdict <run> --pr <n>             render evidence/verdict.md from the results and evidence/judgement.json
  publish <run> --pr <n>             push the evidence to verify-evidence, comment the verdict, set status verify
`;

function print(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function detectKind(root: string, flag: string | undefined): VerifyKind {
  if (flag !== undefined) {
    if (!isVerifyKind(flag))
      throw new Error(`--kind must be one of ${VERIFY_KINDS.join(", ")}`);
    return flag;
  }
  const found = VERIFY_KINDS.filter((kind) =>
    existsSync(join(root, skillFolder(kind), "SKILL.md")),
  );
  if (found.length !== 1)
    throw new Error(
      found.length === 0
        ? "No shared verification skill in this repository: run antelopejs-sync --verify <kind>."
        : `Several shared verification skills: ${found.join(", ")}. Pass --kind.`,
    );
  return found[0];
}

function printMap(workspace: Workspace): number {
  const problems = checkMap(workspace, [...knownJourneys(workspace).keys()]);
  for (const problem of problems) print(problem);
  return problems.length === 0 ? 0 : 1;
}

/** One feature a `journey` call runs and the journey ids it names; no ids runs every journey the feature registers. */
interface FeatureRun {
  feature: string;
  ids: string[];
}

/**
 * The features a `journey` call runs, in order.
 *
 * `journey <run> <feature> [ids...]` runs one feature, or the named journeys
 * of it. `journey <run> --plan` runs every feature `plan` lists as `run` for
 * the run's base and `--all`, `smoke` first. `journey <run> --features a,b`
 * runs the named features whole, in that order. Several features take a flag
 * rather than more positionals because a positional after the feature is a
 * journey id: reading it as a feature whenever a feature file has that name
 * would change what an existing call runs as soon as someone adds a feature
 * named like one of its journeys.
 */
function featureRuns(
  workspace: Workspace,
  rest: string[],
  flags: { plan?: boolean; features?: string },
): FeatureRun[] {
  const [dir, feature, ...ids] = rest;
  if (flags.plan !== true && flags.features === undefined)
    return [{ feature, ids }];
  if (flags.plan === true && flags.features !== undefined)
    throw new Error("journey takes --plan or --features, not both");
  if (feature !== undefined)
    throw new Error(
      "--plan and --features run whole features; name journey ids after one feature: journey <run> <feature> [ids...]",
    );
  if (flags.plan === true) {
    const state = loadRun(dir);
    return planFor(workspace, state.baseRef, state.all).run.map((name) => ({
      feature: name,
      ids: [],
    }));
  }
  const names = (flags.features ?? "").split(",").filter(Boolean);
  if (names.length === 0) throw new Error("--features names no feature");
  return names.map((name) => ({ feature: name, ids: [] }));
}

/**
 * Runs one feature's journeys as its own `journey` call would, and prints its
 * lines once it ends. A feature that cannot run, an unknown feature or
 * journey for one, prints its error on stderr instead.
 * @returns whether every journey it ran passed.
 */
async function journeyFeature(
  workspace: Workspace,
  dir: string,
  { feature, ids }: FeatureRun,
): Promise<boolean> {
  let results: JourneyResult[];
  try {
    results = await runFeature(workspace, loadRun(dir), feature, ids);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return false;
  }
  for (const result of results) {
    print(
      `${result.status} ${feature}/${result.journey}${result.reusedFrom === undefined ? ` (${seconds(result.ms)})` : ` (reuses ${result.reusedFrom}, not run again)`}`,
    );
    for (const step of result.steps)
      for (const check of step.checks.filter((entry) => !entry.pass))
        print(`    ${step.name}: ${check.name} (${check.detail})`);
    if (result.error) print(`    ${result.error.split("\n")[0]}`);
    if (result.notVerified) print(`    ${result.notVerified}`);
  }
  return results.every((result) => result.status === "PASS");
}

/**
 * Runs the features in order, each one as if by its own call: a feature
 * whose journeys fail does not stop the next, and a feature reuses the PASS
 * of a journey an earlier one ran. This loop is the one place a capped
 * number of features would run at once.
 * @returns 1 when any feature had a journey that did not pass or could not run, else 0.
 */
async function runJourneys(
  workspace: Workspace,
  dir: string,
  runs: FeatureRun[],
): Promise<number> {
  let passed = true;
  for (const run of runs)
    passed = (await journeyFeature(workspace, dir, run)) && passed;
  return passed ? 0 : 1;
}

function runFormal(workspace: Workspace, dir: string, all: boolean): number {
  const state = loadRun(dir);
  const plan = planFor(workspace, state.baseRef);
  const touched = touchedFormalChecks(workspace, plan.changed);
  const checks = all ? (workspace.config.formal ?? []) : touched;
  let fails = false;
  for (const check of checks) {
    const gates = touched.includes(check);
    const result = runFormalCheck(
      workspace,
      state,
      check,
      gates
        ? {
            baseSha: plan.baseSha,
            headSha: plan.headSha,
            changed: plan.changed,
          }
        : null,
    );
    const weight = formalGate(result);
    fails ||= gates && weight.fails;
    print(
      `${gates ? (weight.fails ? "FAIL" : "PASS") : "INFO"} ${check.name}: ${weight.outcome}`,
    );
  }
  if (checks.length === 0) print("no formal check covers the diff");
  return fails ? 1 : 0;
}

function printDoors(workspace: Workspace, files: string[]): number {
  const doors = flaggedDoors(workspace, files);
  print(doorLine(doors) || "One-way-door: none flagged by path rules");
  for (const door of doors) print(`  ${door.kind}: ${door.files.join(", ")}`);
  return 0;
}

function judge(
  workspace: Workspace,
  command: "verdict" | "publish",
  dir: string,
  pr: number,
): number {
  if (!Number.isInteger(pr) || pr <= 0)
    throw new Error(`${command} needs --pr <number>`);
  const state = loadRun(dir);
  const verdict = renderVerdict(
    workspace,
    state,
    pr,
    readJudgement(join(state.evidence, "judgement.json")),
  );
  print(verdict.markdown);
  if (command === "publish") {
    print(`evidence commit ${pushEvidence(workspace.root, state, verdict)}`);
    const comment = postComment(workspace.root, verdict);
    print(`comment ${comment}`);
    const status = setStatus(workspace.root, verdict, comment);
    print(status.detail);
    if (!status.ok) return 1;
  }
  return verdict.result === "PASS" || verdict.result === "PASS+NOTES" ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      base: { type: "string", default: "origin/main" },
      title: { type: "string", default: "" },
      pr: { type: "string" },
      all: { type: "boolean" },
      kind: { type: "string" },
      plan: { type: "boolean" },
      features: { type: "string" },
    },
  });
  const [command, ...rest] = positionals;
  if (command === undefined) {
    print(USAGE);
    return 0;
  }
  const root = repositoryRoot();
  const workspace = await openWorkspace(root, detectKind(root, values.kind));
  if (command === "new")
    print(
      (
        await createRun(
          workspace,
          values.base,
          values.title,
          values.all === true,
        )
      ).dir,
    );
  else if (command === "map") return printMap(workspace);
  else if (command === "plan") {
    const plan = planFor(workspace, values.base, values.all === true);
    print(JSON.stringify(plan, null, 2));
    return plan.unmapped.length === 0 ? 0 : 1;
  } else if (command === "doctor") {
    const lines = doctor(workspace, loadRun(rest[0]));
    for (const line of lines)
      print(`${line.ok ? "ok  " : "FAIL"} ${line.check}: ${line.detail}`);
    return lines.every((line) => line.ok) ? 0 : 1;
  } else if (command === "journey")
    return runJourneys(
      workspace,
      rest[0],
      featureRuns(workspace, rest, values),
    );
  else if (command === "formal")
    return runFormal(workspace, rest[0], values.all === true);
  else if (command === "doors")
    return printDoors(
      workspace,
      rest[0] ? patchFiles(rest[0]) : planFor(workspace, values.base).changed,
    );
  else if (command === "clean")
    for (const line of clean(loadRun(rest[0]))) print(line);
  else if (command === "verdict" || command === "publish")
    return judge(workspace, command, rest[0], Number(values.pr));
  else {
    print(USAGE);
    return 2;
  }
  return 0;
}

void runCliAsync(() => main(process.argv.slice(2)));
