import type { Check } from "./types.ts";

/** One step of a journey and the checks made on its evidence. */
export interface StepRecord {
  name: string;
  folder: string;
  checks: Check[];
}

/** How a journey ended: PASS, FAIL, or NOT VERIFIED when it could not reach the product. */
export type JourneyStatus = "PASS" | "FAIL" | "NOT VERIFIED";

/** The outcome of one journey, written as result.json beside its steps. */
export interface JourneyResult {
  feature: string;
  journey: string;
  title: string;
  entryPoint: string;
  status: JourneyStatus;
  steps: StepRecord[];
  error: string | null;
  notVerified: string | null;
  folder: string;
  /** Set when the journey did not run for this feature: the evidence folder, relative to the run's evidence, of the PASS of the same journey that this result reuses. */
  reusedFrom?: string;
  /** The state of the tree the journey ran against: HEAD, the uncommitted diff and the untracked files. A PASS is reused only for the same tree. */
  tree?: string;
}

/** Why a journey ended early: an error, or why it could not reach the product. */
export interface JourneyEnd {
  error: string | null;
  notVerified: string | null;
}
