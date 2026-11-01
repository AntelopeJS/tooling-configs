import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import type { JourneyResult } from "./results.ts";
import { flaggedDoors, patchFiles } from "./doors.ts";
import { readResults } from "./runner.ts";
import { loadRun, type Workspace } from "./workspace.ts";

/**
 * How a seeded break fared: CAUGHT by a product check, MISSED while every
 * journey reached the product, or NOT VERIFIED when no journey caught it and
 * one could not reach the product in either run.
 */
type SeededOutcome = "CAUGHT" | "MISSED" | "NOT VERIFIED";

/** The outcome of one feature's seeded break, judged against an unpatched control run. */
export interface SeededResult {
  feature: string;
  outcome: SeededOutcome;
  run: string;
  controlRun: string;
  caughtBy: string[];
  failingInControl: string[];
  harnessErrors: string[];
  /** Journeys that ended NOT VERIFIED, each with its reason, in the control and with the patch. */
  notVerified: { control: string[]; seeded: string[] };
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

/** Runs a command in a scratch worktree; a failure carries the command's own output, which pnpm writes to stdout. */
function inTree(worktree: string, program: string, args: string[]): string {
  const run = spawnSync(program, args, {
    cwd: worktree,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  if (run.status !== 0)
    throw new Error(
      `${[program, ...args].join(" ")} exited ${run.status ?? run.signal} in ${worktree}\n${`${run.stdout ?? ""}${run.stderr ?? ""}${run.error?.message ?? ""}`.trim().slice(-2000)}`,
    );
  return run.stdout.trim();
}

/**
 * A scratch worktree of HEAD with the skill folder as it is in the checkout,
 * `patch` (a path inside the skill folder) applied when given, and dependencies
 * installed.
 */
export function prepareWorktree(
  workspace: Workspace,
  label: string,
  patch: string | null,
): string {
  const worktree = mkdtempSync(
    join(tmpdir(), `antelopejs-verify-seeded-${label}-`),
  );
  execFileSync(
    "git",
    ["worktree", "add", "--detach", "--force", worktree, "HEAD"],
    { cwd: workspace.root, stdio: "ignore" },
  );
  try {
    const skill = join(worktree, relative(workspace.root, workspace.skill));
    rmSync(skill, { recursive: true, force: true });
    cpSync(workspace.skill, skill, { recursive: true, verbatimSymlinks: true });
    if (patch !== null) inTree(worktree, "git", ["apply", join(skill, patch)]);
    inTree(worktree, "pnpm", [
      "install",
      "--frozen-lockfile",
      "--prefer-offline",
      "--ignore-scripts",
    ]);
  } catch (error) {
    removeWorktree(workspace, worktree);
    throw error;
  }
  return worktree;
}

/** Removes a scratch worktree made by `prepareWorktree`. */
export function removeWorktree(workspace: Workspace, worktree: string): void {
  execFileSync("git", ["worktree", "remove", "--force", worktree], {
    cwd: workspace.root,
    stdio: "ignore",
  });
}

/** Runs a feature's journeys, or only `ids`, in a worktree through the bin: `new`, `journey`, then `clean`. */
export function runFeatureIn(
  bin: string,
  worktree: string,
  feature: string,
  baseRef: string,
  ids: string[] = [],
): FeatureRun {
  const created = spawnSync(process.execPath, [bin, "new", "--base", baseRef], {
    cwd: worktree,
    encoding: "utf8",
  });
  const run = created.stdout.trim().split("\n").at(-1) ?? "";
  if (created.status !== 0 || !existsSync(join(run, "run.json")))
    return { run, results: [], output: `${created.stdout}${created.stderr}` };
  const journeys = spawnSync(
    process.execPath,
    [bin, "journey", run, feature, ...ids],
    {
      cwd: worktree,
      encoding: "utf8",
    },
  );
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

/** Whether a journey result carries a failing check, which tells a product failure from a harness error. */
export function failsACheck(result: JourneyResult): boolean {
  return result.steps.some((step) => step.checks.some((check) => !check.pass));
}

function notVerifiedIn(results: JourneyResult[]): string[] {
  return results
    .filter((result) => result.status === "NOT VERIFIED")
    .map((result) => `${result.journey} (${result.notVerified})`);
}

/**
 * A break is caught only by a journey that passes in the control and fails
 * one of its checks with the patch. A journey that ends NOT VERIFIED, because
 * its environment went away, never counts as a catch, and leaves an uncaught
 * break NOT VERIFIED rather than MISSED.
 */
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
  const caughtBy = failed
    .filter(
      (result) => passedInControl.has(result.journey) && failsACheck(result),
    )
    .map((result) => result.journey);
  const notVerified = {
    control: notVerifiedIn(control.results),
    seeded: notVerifiedIn(
      seeded.results.filter((result) => passedInControl.has(result.journey)),
    ),
  };
  const unreached = notVerified.control.length + notVerified.seeded.length > 0;
  return {
    feature,
    outcome:
      caughtBy.length > 0 ? "CAUGHT" : unreached ? "NOT VERIFIED" : "MISSED",
    run: seeded.run,
    controlRun: control.run,
    caughtBy,
    failingInControl: control.results
      .filter((result) => result.status === "FAIL")
      .map((result) => result.journey),
    harnessErrors: failed
      .filter((result) => !failsACheck(result))
      .map((result) => result.journey),
    notVerified,
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
      const seededTree = prepareWorktree(
        workspace,
        feature,
        join("seeded-breaks", `${feature}.patch`),
      );
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
