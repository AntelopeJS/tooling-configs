#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { runCliAsync } from "../guardrails/cli.ts";
import { repositoryRoot } from "../guardrails/files.ts";
import { runContainments } from "../verify/containments.ts";
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
import { checkSeededDoors, runSeededBreaks } from "../verify/seeded.ts";
import { renderVerdict } from "../verify/verdict.ts";
import { loadRun, openWorkspace, type Workspace } from "../verify/workspace.ts";

const USAGE = `Usage: antelopejs-verify <command>

  map                                check every user-facing file is covered and every feature is complete
  plan [--base <ref>]                map the diff to features; list unmapped surfaces
  new [--base <ref>] [--title <t>]   build, prepare an isolated run, print its folder
  doctor <run>                       check the run is worth driving
  journey <run> <feature> [ids...]   run a feature's journeys and record evidence
  formal <run> [--all]               run the formal checks that cover the diff and gate them on changed behaviour
  doors [patch] [--base <ref>]       print the One-way-door line for a patch, or for the diff
  seeded <feature...> [--base <ref>] run each feature unpatched and with its seeded break
  seeded-doors                       check every seeded door is flagged with its kind
  containments [--base <ref>]        check every Data and Format containment passes unpatched and fails with its seeded door
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

async function runJourneys(
  workspace: Workspace,
  dir: string,
  feature: string,
  ids: string[],
): Promise<number> {
  const results = await runFeature(workspace, loadRun(dir), feature, ids);
  for (const result of results) {
    print(`${result.status} ${feature}/${result.journey}`);
    for (const step of result.steps)
      for (const check of step.checks.filter((entry) => !entry.pass))
        print(`    ${step.name}: ${check.name} (${check.detail})`);
    if (result.error) print(`    ${result.error.split("\n")[0]}`);
    if (result.notVerified) print(`    ${result.notVerified}`);
  }
  return results.every((result) => result.status === "PASS") ? 0 : 1;
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

function runSeeded(
  workspace: Workspace,
  features: string[],
  baseRef: string,
): number {
  const results = runSeededBreaks(
    workspace,
    process.argv[1],
    features,
    baseRef,
  );
  for (const result of results) {
    print(
      `${result.caught ? "CAUGHT" : "MISSED"} ${result.feature} by ${result.caughtBy.join(", ") || "no journey"} (evidence ${result.run}/evidence/${result.feature}, control ${result.controlRun}/evidence/${result.feature})`,
    );
    if (result.failingInControl.length > 0)
      print(
        `    not passing without the patch, not counted: ${result.failingInControl.join(", ")}`,
      );
    if (result.harnessErrors.length > 0)
      print(
        `    failed without a failing check (harness error), not counted: ${result.harnessErrors.join(", ")}`,
      );
    print(result.output.replace(/^/gm, "    "));
  }
  return results.every((result) => result.caught) ? 0 : 1;
}

function runSeededDoors(workspace: Workspace): number {
  const doors = checkSeededDoors(workspace);
  for (const door of doors)
    print(
      `${door.flagged ? "FLAGGED" : "MISSED"} ${door.kind} (path rules flag: ${door.kinds.join(", ") || "nothing"})`,
    );
  return doors.every((door) => door.flagged) ? 0 : 1;
}

function runContainmentCheck(workspace: Workspace, baseRef: string): number {
  const results = runContainments(workspace, process.argv[1], baseRef);
  for (const result of results) {
    print(
      `${result.outcome} ${result.kind} ${result.containment}: ${result.detail}${result.run ? ` (evidence ${result.run}, control ${result.controlRun})` : ""}`,
    );
  }
  if (results.length === 0) print("no Data or Format door names a containment");
  return results.length > 0 &&
    results.every((result) => result.outcome === "CONTAINED")
    ? 0
    : 1;
}

const PROOF_COMMANDS = new Set(["seeded", "seeded-doors", "containments"]);

function proofCommand(
  workspace: Workspace,
  command: string,
  features: string[],
  baseRef: string,
): number {
  if (command === "seeded") return runSeeded(workspace, features, baseRef);
  if (command === "seeded-doors") return runSeededDoors(workspace);
  return runContainmentCheck(workspace, baseRef);
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
    print((await createRun(workspace, values.base, values.title)).dir);
  else if (command === "map") return printMap(workspace);
  else if (command === "plan") {
    const plan = planFor(workspace, values.base);
    print(JSON.stringify(plan, null, 2));
    return plan.unmapped.length === 0 ? 0 : 1;
  } else if (command === "doctor") {
    const lines = doctor(workspace, loadRun(rest[0]));
    for (const line of lines)
      print(`${line.ok ? "ok  " : "FAIL"} ${line.check}: ${line.detail}`);
    return lines.every((line) => line.ok) ? 0 : 1;
  } else if (command === "journey")
    return runJourneys(workspace, rest[0], rest[1], rest.slice(2));
  else if (command === "formal")
    return runFormal(workspace, rest[0], values.all === true);
  else if (command === "doors")
    return printDoors(
      workspace,
      rest[0] ? patchFiles(rest[0]) : planFor(workspace, values.base).changed,
    );
  else if (PROOF_COMMANDS.has(command))
    return proofCommand(workspace, command, rest, values.base);
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
