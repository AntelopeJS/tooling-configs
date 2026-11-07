import type { StepTiming } from "./timing.ts";
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
  /** The journey's duration in milliseconds, its processes' cleanup included and the deletion of its scratch folder and HOME, which runs after this result is written, excluded; absent in a result an older version wrote. */
  ms?: number;
  /** How long each step folder lasted, from its `step()` call to the next one or the journey's end; absent in a result an older version wrote. */
  stepMs?: StepTiming[];
}

/** Why a journey ended early: an error, or why it could not reach the product. */
export interface JourneyEnd {
  error: string | null;
  notVerified: string | null;
}
