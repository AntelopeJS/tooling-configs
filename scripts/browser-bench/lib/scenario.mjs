import { setTimeout as sleep } from "node:timers/promises";
import { createRecorder, measured, runSteps } from "./runner.mjs";
import { IDLE_PREP, LATENCY_STEPS, SCENARIO_STEPS } from "./steps.mjs";

const IDLE_SETTLE_MS = 3000;
const IDLE_WINDOW_MS = 5000;

/**
 * A driver is what a variant brings: `start` brings the browser up,
 * `execute` runs one step, `finish` closes it inside the timed region,
 * `release` frees a warm browser's per-run state, and `dispose` cleans up
 * after a failure.
 *
 * @typedef {{ start: (scenario: string, recorder: ReturnType<typeof createRecorder>) => Promise<void>, execute: (step: Record<string, any>, pngPath: string) => Promise<{ text?: string, value?: unknown, path?: string }>, finish: (scenario: string) => Promise<void>, release: () => Promise<void>, dispose: () => Promise<void> }} Driver
 */

/**
 * @param {{ scenario: string, outDir: string }} config The run config
 * @param {Driver} driver The variant's driver
 * @param {ReturnType<typeof createRecorder>} recorder The recorder
 * @returns {Parameters<typeof measured>[2]} The untimed and timed phases
 */
function phasesFor(config, driver, recorder) {
  const run = (steps) =>
    runSteps(steps, driver.execute, recorder, config.outDir);
  const { scenario } = config;
  switch (scenario) {
    case "cold":
    case "session":
    case "accounts":
      return {
        body: async () => {
          try {
            await driver.start(scenario, recorder);
            await run(SCENARIO_STEPS[scenario]);
            await recorder.step("close", () => driver.finish(scenario));
          } finally {
            await driver.dispose();
          }
        },
      };
    case "session-warm":
      return {
        before: () => driver.start(scenario, recorder),
        body: () => run(SCENARIO_STEPS[scenario]),
        after: async () => {
          await driver.release();
          await driver.dispose();
        },
      };
    case "idle":
      return {
        before: async () => {
          await driver.start(scenario, recorder);
          await run(IDLE_PREP);
          await sleep(IDLE_SETTLE_MS);
        },
        body: () => sleep(IDLE_WINDOW_MS),
        after: () => driver.dispose(),
      };
    case "latency":
      return {
        before: async () => {
          await driver.start(scenario, recorder);
          await run([{ op: "goto", path: "/login.html" }]);
        },
        body: () => run(LATENCY_STEPS),
        after: () => driver.dispose(),
      };
    default:
      throw new Error(`unknown scenario ${scenario}`);
  }
}

/**
 * @param {(config: Record<string, any>) => Driver} makeDriver Builds the variant's driver from the run config
 * @returns {Promise<never>} Exits the process when done
 */
export async function main(makeDriver) {
  const config = JSON.parse(process.argv[2]);
  const driver = makeDriver(config);
  const recorder = createRecorder();
  await measured(config, recorder, phasesFor(config, driver, recorder));
  process.exit(0);
}
