import {
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { performance } from "node:perf_hooks";
import { readCgroup } from "./cgroup.mjs";
import { labelOf } from "./steps.mjs";

/** @returns {{ steps: Array<{ label: string, ms: number }>, errors: string[], facts: Record<string, number>, step: <T>(label: string, run: () => Promise<T>) => Promise<T> }} A recorder */
export function createRecorder() {
  const steps = [];
  const errors = [];
  const facts = {};
  return {
    steps,
    errors,
    facts,
    async step(label, run) {
      const start = performance.now();
      try {
        const outcome = await run();
        steps.push({ label, ms: performance.now() - start });
        return outcome;
      } catch (error) {
        steps.push({ label, ms: performance.now() - start, failed: true });
        errors.push(
          `${label}: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            300,
          ),
        );
        throw error;
      }
    },
  };
}

/**
 * @param {string} path A PNG file
 * @returns {{ ok: boolean, width: number, height: number, bytes: number }} Whether it is a PNG, with its size
 */
function readPng(path) {
  const header = Buffer.alloc(24);
  const file = openSync(path, "r");
  try {
    readSync(file, header, 0, 24, 0);
  } finally {
    closeSync(file);
  }
  const isPng = header.subarray(1, 4).toString("latin1") === "PNG";
  return {
    ok: isPng,
    width: header.readUInt32BE(16),
    height: header.readUInt32BE(20),
    bytes: statSync(path).size,
  };
}

/**
 * Checks that a step really did its work, so a fast failure never counts as
 * a fast success.
 *
 * @param {Record<string, any>} step The step
 * @param {{ text?: string, value?: unknown, path?: string }} outcome What the driver answered
 * @param {string} label The step label
 * @param {ReturnType<typeof createRecorder>} recorder Where facts and errors go
 */
function verifyStep(step, outcome, label, recorder) {
  const fail = (message) => recorder.errors.push(`${label}: ${message}`);
  if (step.op === "snapshot") {
    for (const needle of step.expect ?? [])
      if (!outcome.text?.includes(needle)) fail(`snapshot lacks "${needle}"`);
    recorder.facts[`snapshotBytes ${label}`] = Buffer.byteLength(
      outcome.text ?? "",
    );
  }
  if (
    "expectJson" in step &&
    JSON.stringify(outcome.value) !== JSON.stringify(step.expectJson)
  )
    fail(
      `eval returned ${JSON.stringify(outcome.value)}, wanted ${JSON.stringify(step.expectJson)}`,
    );
  if (step.op === "screenshot") {
    const png = readPng(outcome.path);
    recorder.facts[`screenshotBytes ${label}`] = png.bytes;
    recorder.facts[`screenshotHeight ${label}`] = png.height;
    if (!png.ok) fail("screenshot is not a PNG");
    if (step.minHeight && png.height < step.minHeight)
      fail(`screenshot height ${png.height} < ${step.minHeight}`);
    if (step.maxHeight && png.height > step.maxHeight)
      fail(`screenshot height ${png.height} > ${step.maxHeight}`);
  }
}

/**
 * @param {Array<Record<string, any>>} steps The steps
 * @param {(step: Record<string, any>, pngPath: string) => Promise<{ text?: string, value?: unknown, path?: string }>} execute Runs one step on a driver
 * @param {ReturnType<typeof createRecorder>} recorder The recorder
 * @param {string} outDir Where screenshots go
 */
export async function runSteps(steps, execute, recorder, outDir) {
  for (const [index, step] of steps.entries()) {
    const label = labelOf(step, index);
    const pngPath = `${outDir}/${String(index + 1).padStart(2, "0")}.png`;
    const outcome = await recorder.step(label, () => execute(step, pngPath));
    verifyStep(step, { path: pngPath, ...outcome }, label, recorder);
  }
}

/**
 * Times `body` and records wall time, cgroup CPU, runner CPU, CPU pressure
 * and major faults across it. Empty marker files tell the sampler where the
 * timed region starts and ends.
 *
 * @param {{ outDir: string, resultPath: string }} config The run config
 * @param {ReturnType<typeof createRecorder>} recorder The recorder
 * @param {{ before?: () => Promise<unknown>, body: (prepared: any) => Promise<void>, after?: (prepared: any) => Promise<void> }} phases The phases
 */
export async function measured(config, recorder, phases) {
  mkdirSync(config.outDir, { recursive: true });
  const prepared = phases.before ? await phases.before() : undefined;
  writeFileSync(`${config.resultPath}.t0`, "");
  const stat0 = readCgroup();
  const own0 = process.cpuUsage();
  const t0 = performance.now();
  try {
    await phases.body(prepared);
  } catch (error) {
    if (recorder.errors.length === 0)
      recorder.errors.push(String(error).slice(0, 300));
  }
  const wallMs = performance.now() - t0;
  const own = process.cpuUsage(own0);
  const stat1 = readCgroup();
  writeFileSync(`${config.resultPath}.t1`, "");
  writeFileSync(
    config.resultPath,
    JSON.stringify({
      wallMs,
      cpuUsec: stat1.cpuUsec - stat0.cpuUsec,
      runnerCpuUsec: own.user + own.system,
      pressureUsec: stat1.pressureUsec - stat0.pressureUsec,
      majorFaults: stat1.majorFaults - stat0.majorFaults,
      cgroupPeakBytes: stat1.peakBytes,
      steps: recorder.steps,
      errors: recorder.errors,
      facts: recorder.facts,
    }),
  );
  if (phases.after) await phases.after(prepared);
}
