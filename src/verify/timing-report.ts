import type { FormalResult } from "./formal.ts";
import type { JourneyResult } from "./results.ts";
import { seconds, type PhaseTiming, type StepTiming } from "./timing.ts";

/** A journey's place in the timing report; `ms` is `null` for a result an older version wrote. */
interface JourneyTiming {
  feature: string;
  journey: string;
  ms: number | null;
  slowestSteps: StepTiming[];
}

/** A formal check's place in the timing report; `ms` is `null` for a result an older version wrote. */
interface FormalTiming {
  name: string;
  ms: number | null;
}

/** Every measurement a verdict shows, and the sum of those that exist. */
export interface TimingReport {
  setup: PhaseTiming[];
  journeys: JourneyTiming[];
  formal: FormalTiming[];
  totalMs: number;
}

/** The journey results of one feature, as the verdict lists them. */
export interface FeatureResults {
  feature: string;
  results: JourneyResult[];
}

/** How many of a journey's steps the verdict names. */
const SLOWEST_STEPS = 3;

/** The label of the verdict's last timing row; it states what the sum leaves out. */
const TOTAL_LABEL =
  "**Total measured** (commands only; agent time between commands is not included)";

function sum(values: (number | null)[]): number {
  return values.reduce<number>((total, ms) => total + (ms ?? 0), 0);
}

function slowest(steps: StepTiming[]): StepTiming[] {
  return steps.toSorted((a, b) => b.ms - a.ms).slice(0, SLOWEST_STEPS);
}

/** Collects what a run measured: its `new` phases, each journey's total and slowest steps, each formal check. */
export function timingReport(
  setup: PhaseTiming[],
  features: FeatureResults[],
  formal: FormalResult[],
): TimingReport {
  const journeys = features.flatMap(({ feature, results }) =>
    results.map((result) => ({
      feature,
      journey: result.journey,
      ms: result.ms ?? null,
      slowestSteps: slowest(result.stepMs ?? []),
    })),
  );
  const checks = formal.map((result) => ({
    name: result.name,
    ms: result.ms ?? null,
  }));
  return {
    setup,
    journeys,
    formal: checks,
    totalMs:
      sum(setup.map((entry) => entry.ms)) +
      sum(journeys.map((entry) => entry.ms)) +
      sum(checks.map((entry) => entry.ms)),
  };
}

function journeyCell(entry: JourneyTiming): string {
  if (entry.ms === null || entry.slowestSteps.length === 0)
    return seconds(entry.ms);
  const steps = entry.slowestSteps
    .map((step) => `\`${step.step}\` ${seconds(step.ms)}`)
    .join(", ");
  return `${seconds(entry.ms)} (slowest steps: ${steps})`;
}

/** The `### Timing` table of a verdict: one row per measured phase, journey and formal check, then the sum. */
export function timingTable(report: TimingReport): string[] {
  const setup =
    report.setup.length > 0
      ? report.setup.map((entry) => `| ${entry.phase} | ${seconds(entry.ms)} |`)
      : [`| new (setup, pack, services, sources) | ${seconds(null)} |`];
  return [
    "| Phase | Time |",
    "|---|---|",
    ...setup,
    ...report.journeys.map(
      (entry) =>
        `| journey ${entry.feature}/${entry.journey} | ${journeyCell(entry)} |`,
    ),
    ...report.formal.map(
      (entry) => `| formal ${entry.name} | ${seconds(entry.ms)} |`,
    ),
    `| ${TOTAL_LABEL} | ${seconds(report.totalMs)} |`,
  ];
}
