import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import type { JourneyResult } from "./results.ts";
import { flaggedDoors, patchFiles } from "./doors.ts";
import { readResults } from "./runner.ts";
import { loadRun, type Workspace } from "./workspace.ts";

/** The outcome of one feature's seeded break, judged against an unpatched control run. */
export interface SeededResult {
  feature: string;
  caught: boolean;
  run: string;
  controlRun: string;
  caughtBy: string[];
  failingInControl: string[];
  harnessErrors: string[];
  output: string;
}

/** Whether a seeded door patch is flagged with its own kind by the path rules. */
export interface SeededDoor {
  kind: string;
  flagged: boolean;
  kinds: string[];
}

/** One run of a feature in a scratch worktree: its folder, its journey results and what the bin printed. */
export interface FeatureRun {
  run: string;
  results: JourneyResult[];
  output: string;
}

function inTree(worktree: string, program: string, args: string[]): string {
  return execFileSync(program, args, {
    cwd: worktree,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function prepareWorktree(
  workspace: Workspace,
  label: string,
  feature: string | null,
): string {
  const worktree = mkdtempSync(
    join(tmpdir(), `antelopejs-verify-seeded-${label}-`),
  );
  execFileSync(
    "git",
    ["worktree", "add", "--detach", "--force", worktree, "HEAD"],
    { cwd: workspace.root, stdio: "ignore" },
  );
  const skill = join(worktree, relative(workspace.root, workspace.skill));
  rmSync(skill, { recursive: true, force: true });
  cpSync(workspace.skill, skill, { recursive: true, verbatimSymlinks: true });
  if (feature !== null)
    inTree(worktree, "git", [
      "apply",
      join(skill, "seeded-breaks", `${feature}.patch`),
    ]);
  inTree(worktree, "pnpm", [
    "install",
    "--frozen-lockfile",
    "--prefer-offline",
    "--ignore-scripts",
  ]);
  return worktree;
}

function removeWorktree(workspace: Workspace, worktree: string): void {
  execFileSync("git", ["worktree", "remove", "--force", worktree], {
    cwd: workspace.root,
    stdio: "ignore",
  });
}

function runFeatureIn(
  bin: string,
  worktree: string,
  feature: string,
  baseRef: string,
): FeatureRun {
  const created = spawnSync(process.execPath, [bin, "new", "--base", baseRef], {
    cwd: worktree,
    encoding: "utf8",
  });
  const run = created.stdout.trim().split("\n").at(-1) ?? "";
  if (created.status !== 0 || !existsSync(join(run, "run.json")))
    return { run, results: [], output: `${created.stdout}${created.stderr}` };
  const journeys = spawnSync(process.execPath, [bin, "journey", run, feature], {
    cwd: worktree,
    encoding: "utf8",
  });
  const cleaned = spawnSync(process.execPath, [bin, "clean", run], {
    cwd: worktree,
    encoding: "utf8",
  });
  return {
    run,
    results: readResults(loadRun(run), feature) ?? [],
    output: `${journeys.stdout}${journeys.stderr}${cleaned.stderr}`,
  };
}

function failsACheck(result: JourneyResult): boolean {
  return result.steps.some((step) => step.checks.some((check) => !check.pass));
}

/** A break is caught only by a journey that passes in the control and fails one of its checks with the patch. */
export function judgeSeeded(
  feature: string,
  control: FeatureRun,
  seeded: FeatureRun,
): SeededResult {
  const passedInControl = new Set(
    control.results
      .filter((result) => result.status === "PASS")
      .map((result) => result.journey),
  );
  const failed = seeded.results.filter((result) => result.status === "FAIL");
  return {
    feature,
    caught: failed.some(
      (result) => passedInControl.has(result.journey) && failsACheck(result),
    ),
    run: seeded.run,
    controlRun: control.run,
    caughtBy: failed
      .filter(
        (result) => passedInControl.has(result.journey) && failsACheck(result),
      )
      .map((result) => result.journey),
    failingInControl: control.results
      .filter((result) => result.status !== "PASS")
      .map((result) => result.journey),
    harnessErrors: failed
      .filter((result) => !failsACheck(result))
      .map((result) => result.journey),
    output: seeded.output,
  };
}

/**
 * Runs each feature's journeys twice from scratch worktrees of HEAD, with the
 * skill folder as it is in the checkout: once unpatched as the control, once
 * with seeded-breaks/<feature>.patch applied. Each run is cleaned afterwards;
 * both runs' evidence stays.
 */
export function runSeededBreaks(
  workspace: Workspace,
  bin: string,
  features: string[],
  baseRef: string,
): SeededResult[] {
  const controlTree = prepareWorktree(workspace, "control", null);
  try {
    return features.map((feature) => {
      const control = runFeatureIn(bin, controlTree, feature, baseRef);
      const seededTree = prepareWorktree(workspace, feature, feature);
      try {
        return judgeSeeded(
          feature,
          control,
          runFeatureIn(bin, seededTree, feature, baseRef),
        );
      } finally {
        removeWorktree(workspace, seededTree);
      }
    });
  } finally {
    removeWorktree(workspace, controlTree);
  }
}

/** Checks every seeded-doors/<kind>.patch: the path rules must flag its own kind. */
export function checkSeededDoors(workspace: Workspace): SeededDoor[] {
  const folder = join(workspace.skill, "seeded-doors");
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((file) => file.endsWith(".patch"))
    .sort()
    .map((file) => {
      const kind = file.replace(/\.patch$/, "");
      const kinds = flaggedDoors(workspace, patchFiles(join(folder, file))).map(
        (door) => door.kind,
      );
      return { kind, flagged: kinds.some((found) => found === kind), kinds };
    });
}
