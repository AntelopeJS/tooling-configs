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
}

/** Why a journey ended early: an error, or why it could not reach the product. */
export interface JourneyEnd {
  error: string | null;
  notVerified: string | null;
}
