import { existsSync } from "node:fs";
import { join } from "node:path";

import type { JourneyResult } from "./results.ts";
import {
  failsACheck,
  prepareWorktree,
  removeWorktree,
  runFeatureIn,
  type FeatureRun,
} from "./seeded.ts";
import type { Workspace } from "./workspace.ts";

/** The door kinds whose containment is a journey that must fail with the kind's seeded door. */
const CONTAINED = ["data", "format"] as const;

/** How one containment journey fared against its kind's seeded door. */
export type ContainmentOutcome =
  | "CONTAINED"
  | "MISSED"
  | "UNPROVEN"
  | "NO-DOOR";

/** One containment journey judged against the unpatched control and the run with its seeded door applied. */
export interface ContainmentResult {
  kind: (typeof CONTAINED)[number];
  containment: string;
  outcome: ContainmentOutcome;
  detail: string;
  run: string;
  controlRun: string;
}

/** The outcome of one containment and why. */
interface Judged {
  outcome: ContainmentOutcome;
  detail: string;
}

/**
 * A containment works only when it passes unpatched and then fails one of its
 * own checks with the door applied. A pass with the door means it contains
 * nothing; anything else leaves it unproven.
 */
export function judgeContainment(
  control: JourneyResult | undefined,
  withDoor: JourneyResult | undefined,
): Judged {
  if (control === undefined || control.status !== "PASS")
    return {
      outcome: "UNPROVEN",
      detail: `it does not pass on the unpatched control (${control?.status ?? "not run"}), so its failure with the door proves nothing`,
    };
  if (withDoor === undefined)
    return { outcome: "UNPROVEN", detail: "it did not run with the door" };
  if (withDoor.status === "PASS")
    return {
      outcome: "MISSED",
      detail:
        "it passes with its seeded door applied: it contains nothing, so a door row naming it proves no containment",
    };
  if (withDoor.status === "FAIL" && failsACheck(withDoor))
    return {
      outcome: "CONTAINED",
      detail: "it passes unpatched and fails a check with its door",
    };
  return {
    outcome: "UNPROVEN",
    detail: `with the door it ended ${withDoor.status} without a failing check, a harness error rather than a caught door`,
  };
}

function split(containment: string): [string, string] {
  const [feature, journey] = containment.split("/");
  return [feature, journey];
}

function byFeature(containments: string[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const containment of containments) {
    const [feature, journey] = split(containment);
    grouped.set(feature, [...(grouped.get(feature) ?? []), journey]);
  }
  return grouped;
}

function resultOf(run: FeatureRun, containment: string) {
  const [, journey] = split(containment);
  return run.results.find((result) => result.journey === journey);
}

/**
 * Runs every Data and Format containment journey twice from scratch worktrees
 * of HEAD: unpatched as the control, then with `seeded-doors/<kind>.patch`
 * applied. A containment is proven only when it passes in the control and
 * fails a check with its door. A kind with no seeded door reports `NO-DOOR`.
 */
export function runContainments(
  workspace: Workspace,
  bin: string,
  baseRef: string,
): ContainmentResult[] {
  const rules = CONTAINED.flatMap((kind) => {
    const rule = workspace.config.doors[kind];
    return rule && rule.containments.length > 0
      ? [{ kind, containments: rule.containments }]
      : [];
  });
  if (rules.length === 0) return [];
  const controlTree = prepareWorktree(workspace, "control", null);
  try {
    const controls = new Map<string, FeatureRun>();
    for (const [feature, ids] of byFeature([
      ...new Set(rules.flatMap((rule) => rule.containments)),
    ]))
      controls.set(
        feature,
        runFeatureIn(bin, controlTree, feature, baseRef, ids),
      );
    return rules.flatMap((rule) =>
      judgeKind(workspace, { bin, baseRef }, rule, controls),
    );
  } finally {
    removeWorktree(workspace, controlTree);
  }
}

function judgeKind(
  workspace: Workspace,
  command: { bin: string; baseRef: string },
  rule: { kind: (typeof CONTAINED)[number]; containments: string[] },
  controls: Map<string, FeatureRun>,
): ContainmentResult[] {
  const { kind, containments } = rule;
  const patch = join("seeded-doors", `${kind}.patch`);
  if (!existsSync(join(workspace.skill, patch)))
    return containments.map((containment) => ({
      kind,
      containment,
      outcome: "NO-DOOR",
      detail: `seeded-doors/${kind}.patch is missing, so nothing proves the containment fails with the door`,
      run: "",
      controlRun: "",
    }));
  const tree = prepareWorktree(workspace, kind, patch);
  try {
    const doors = new Map<string, FeatureRun>();
    for (const [feature, ids] of byFeature(containments))
      doors.set(
        feature,
        runFeatureIn(command.bin, tree, feature, command.baseRef, ids),
      );
    return containments.map((containment) => {
      const [feature] = split(containment);
      const control = controls.get(feature);
      const door = doors.get(feature);
      return {
        kind,
        containment,
        ...judgeContainment(
          control && resultOf(control, containment),
          door && resultOf(door, containment),
        ),
        run: door?.run ?? "",
        controlRun: control?.run ?? "",
      };
    });
  } finally {
    removeWorktree(workspace, tree);
  }
}
