import { type ChildProcess, spawn } from "node:child_process";
import { availableParallelism, constants } from "node:os";

import { killGroup } from "./record.ts";
import { commandRecords } from "./workspace.ts";

/** One feature a `journey` call runs and the journey ids it names; no ids runs every journey the feature registers. */
export interface FeatureRun {
  feature: string;
  ids: string[];
}

/** A feature of a `journey --jobs` call, the earlier features it waits for, its process while it runs, and its output once that process ended. */
interface Slot {
  run: FeatureRun;
  after: number[];
  state: "waiting" | "running" | "ended";
  child?: ChildProcess;
  stdout: Buffer[];
  stderr: Buffer[];
  passed: boolean;
}

const INTERRUPTS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;

/** How long a feature's process may take, after an interrupt, to stop what its journey started before it is killed. */
const GRACE_MS = 5000;

/**
 * The most features a `journey` call runs at once: `requested`, capped at
 * the number of features and at half the logical cores, one feature per
 * physical core where each core runs two threads. A feature is mostly an
 * app booting under `ajs project dev`, which keeps a core busy, so features
 * past one per physical core slow each other's boot more than they overlap
 * it. The cap only stops a count that oversubscribes the machine; the
 * synced skill recommends 4 on an otherwise idle machine.
 */
export function jobLimit(requested: number, features: number): number {
  return Math.max(
    1,
    Math.min(requested, features, Math.floor(availableParallelism() / 2)),
  );
}

/**
 * For each feature, the earlier features of the list it waits for: the
 * same feature listed again, or one that registers a journey id it
 * registers too. A journey listed under two features runs once in a
 * sequential call and the later feature reuses its PASS (#194); running the
 * two at once would run it twice and print another line. Waiting keeps the
 * reuse, and with it the sequential output and evidence, at the cost of the
 * overlap of those two features only.
 */
function dependencies(
  runs: FeatureRun[],
  journeysOf: (feature: string) => string[],
): number[][] {
  const ids = runs.map((run) => new Set(journeysOf(run.feature)));
  return runs.map((run, index) =>
    runs.flatMap((earlier, before) =>
      before < index &&
      (earlier.feature === run.feature ||
        [...ids[before]].some((id) => ids[index].has(id)))
        ? [before]
        : [],
    ),
  );
}

/**
 * Starts `args` under this Node in a process group of its own, so a
 * terminal's interrupt reaches it once, through {@link runConcurrently}, and
 * collects what it prints into `slot`. Resolves once it exited. A process
 * that ended on a signal or could not start is named on its stderr.
 */
function runProcess(slot: Slot, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    slot.child = child;
    child.stdout.on("data", (chunk: Buffer) => slot.stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => slot.stderr.push(chunk));
    const end = (passed: boolean, note?: string) => {
      if (note !== undefined)
        slot.stderr.push(Buffer.from(`${slot.run.feature}: ${note}\n`));
      slot.passed = passed;
      resolve();
    };
    child.once("error", (error) =>
      end(false, `its journey process could not start: ${error.message}`),
    );
    child.once("close", (code, signal) =>
      signal === null
        ? end(code === 0)
        : end(false, `its journey process ended on ${signal}`),
    );
  });
}

/**
 * Runs each feature in its own `journey <run> <feature>` process, `jobs` at
 * a time, and prints each feature's output whole, in the order of `runs`,
 * as soon as it and every feature before it have ended. A process per
 * feature gives each one the `process.env`, verify.config.ts module state
 * and uncaught-error handler its own call would have, which features
 * sharing one process could not keep apart while running at once. A feature
 * whose process fails, ends on a signal or leaves an uncaught error does not
 * stop the others.
 *
 * An interrupt reaches every running feature's process, which stops what
 * its journey started. A process still running {@link GRACE_MS} later, or
 * at a second interrupt, is killed with its process group, and so is every
 * process its records file in `dir` names. The call then prints the output
 * of every feature that ended, in order, names on stderr the features that
 * never started, and exits with the shell's code for the first signal.
 * @param dir the run folder, whose records files name what each feature's process started.
 * @param argsOf the arguments, after the Node executable, of the process that runs one feature.
 * @returns 1 when any feature's process failed, else 0.
 */
export async function runConcurrently(
  dir: string,
  runs: FeatureRun[],
  jobs: number,
  journeysOf: (feature: string) => string[],
  argsOf: (run: FeatureRun) => string[],
): Promise<number> {
  const after = dependencies(runs, journeysOf);
  const slots: Slot[] = runs.map((run, index) => ({
    run,
    after: after[index],
    state: "waiting",
    stdout: [],
    stderr: [],
    passed: false,
  }));
  const printed = new Set<Slot>();
  const print = (slot: Slot) => {
    printed.add(slot);
    process.stdout.write(Buffer.concat(slot.stdout));
    process.stderr.write(Buffer.concat(slot.stderr));
  };
  const flush = () => {
    for (const slot of slots) {
      if (slot.state !== "ended") return;
      if (!printed.has(slot)) print(slot);
    }
  };
  let interrupted: (typeof INTERRUPTS)[number] | undefined;
  const ready = () =>
    interrupted === undefined
      ? slots.find(
          (slot) =>
            slot.state === "waiting" &&
            slot.after.every((index) => slots[index].state === "ended"),
        )
      : undefined;
  const busy = () => slots.filter((slot) => slot.state === "running").length;
  const kill = () => {
    for (const slot of slots) {
      const pid = slot.child?.pid;
      if (slot.state !== "running" || pid === undefined) continue;
      killGroup(pid);
      for (const record of commandRecords(dir, pid)) killGroup(record.pid);
    }
  };
  let deadline: NodeJS.Timeout | undefined;
  const forward = (signal: (typeof INTERRUPTS)[number]) => {
    if (interrupted !== undefined) {
      kill();
      return;
    }
    interrupted = signal;
    for (const slot of slots)
      if (slot.state === "running") slot.child?.kill(signal);
    deadline = setTimeout(kill, GRACE_MS);
  };
  for (const signal of INTERRUPTS) process.on(signal, forward);
  await new Promise<void>((done) => {
    const fill = () => {
      for (
        let slot = ready();
        slot !== undefined && busy() < jobs;
        slot = ready()
      ) {
        const started = slot;
        started.state = "running";
        void runProcess(started, argsOf(started.run)).then(() => {
          started.state = "ended";
          flush();
          fill();
        });
      }
      if (busy() === 0 && (interrupted !== undefined || ready() === undefined))
        done();
    };
    fill();
  });
  clearTimeout(deadline);
  for (const signal of INTERRUPTS) process.off(signal, forward);
  if (interrupted === undefined)
    return slots.every((slot) => slot.passed) ? 0 : 1;
  for (const slot of slots)
    if (slot.state === "ended" && !printed.has(slot)) print(slot);
  const unrun = slots.filter((slot) => slot.state === "waiting");
  if (unrun.length > 0)
    process.stderr.write(
      `not run: ${unrun.map((slot) => slot.run.feature).join(", ")}\n`,
    );
  process.exit(128 + constants.signals[interrupted]);
}
