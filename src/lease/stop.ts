import { readdirSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { leaseMarker } from "./env.ts";
import { assertSignallable, identify } from "./procs.ts";
import type { LeaseId } from "./protocol.ts";
import {
  windowsProcesses,
  windowsTerminate,
  type WindowsProcess,
} from "./windows.ts";

const GRACE_MS = 5_000;
const KILL_WAIT_MS = 2_000;
const POLL_MS = 50;
const ROUNDS = 3;

/** One process of the lease, with the start time that must still match when it is signalled. */
interface Target {
  readonly pid: number;
  readonly start: string;
  readonly command: string;
}

/** This process and its ancestors, which no stop may signal. */
function ancestry(): ReadonlySet<number> {
  const pids = new Set<number>([process.pid]);
  let at = identify(process.pid);
  while (at !== undefined && !pids.has(at.ppid)) {
    pids.add(at.ppid);
    at = identify(at.ppid);
  }
  return pids;
}

function procEntries(pid: number, file: string): string[] {
  try {
    return readFileSync(`/proc/${pid}/${file}`, "utf8").split("\0");
  } catch {
    return [];
  }
}

/**
 * The live processes of this user whose environment holds `marker`, except `shield`. The start time
 * is read before and after the environment, so the environment read belongs to the process found.
 */
function discover(marker: string, shield: ReadonlySet<number>): Target[] {
  const uid = process.getuid?.();
  return readdirSync("/proc")
    .filter((name) => /^\d+$/u.test(name))
    .map(Number)
    .flatMap((pid) => {
      const found = identify(pid);
      if (found === undefined || found.uid !== uid || shield.has(pid))
        return [];
      if (!procEntries(pid, "environ").includes(marker)) return [];
      const command = procEntries(pid, "cmdline").join(" ");
      if (identify(pid)?.start !== found.start) return [];
      return [
        {
          pid,
          start: found.start,
          command: command.replace(/\s+/gu, " ").trim(),
        },
      ];
    });
}

/** Whether `target` is still the process it was found as. A zombie has exited. */
function alive(target: Target): boolean {
  return identify(target.pid)?.start === target.start;
}

function signal(target: Target, name: NodeJS.Signals): void {
  assertSignallable(target.pid);
  if (!alive(target)) return;
  try {
    process.kill(target.pid, name);
  } catch {
    return;
  }
}

async function untilGone(
  targets: readonly Target[],
  ms: number,
): Promise<Target[]> {
  const deadline = Date.now() + ms;
  let left = targets.filter(alive);
  while (left.length > 0 && Date.now() < deadline) {
    await sleep(POLL_MS);
    left = left.filter(alive);
  }
  return left;
}

async function terminate(
  found: readonly Target[],
  report: (line: string) => void,
): Promise<void> {
  for (const target of found) signal(target, "SIGTERM");
  const stubborn = await untilGone(found, GRACE_MS);
  for (const target of stubborn) signal(target, "SIGKILL");
  const survivors = await untilGone(stubborn, KILL_WAIT_MS);
  for (const target of found)
    if (!survivors.includes(target))
      report(`stopped pid ${target.pid} (${target.command})`);
  if (survivors.length > 0)
    throw new Error(
      `antelopejs-lease: pid ${survivors.map((target) => target.pid).join(", ")} still running ${KILL_WAIT_MS / 1000} s after SIGKILL`,
    );
}

/** How one platform finds a lease's processes and stops them. */
interface Stopper {
  readonly discover: (marker: string) => Target[];
  readonly terminate: (
    found: readonly Target[],
    report: (line: string) => void,
  ) => Promise<void>;
}

function linuxStopper(): Stopper {
  const shield = ancestry();
  return { discover: (marker) => discover(marker, shield), terminate };
}

/** This process and its ancestors in `table`. A parent created after its child is a reused pid, not the parent. */
function windowsAncestry(table: readonly WindowsProcess[]): Set<number> {
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  const pids = new Set<number>([process.pid]);
  let at = byPid.get(process.pid);
  while (at !== undefined) {
    const parent = byPid.get(at.ppid);
    if (
      parent === undefined ||
      pids.has(parent.pid) ||
      BigInt(parent.start) > BigInt(at.start)
    )
      break;
    pids.add(parent.pid);
    at = parent;
  }
  return pids;
}

/** A console host, by its executable. It inherits the environment of the process whose console it hosts, and ending it ends every process on that console, the stop's own included. */
const CONSOLE_HOST =
  /^(?:"(?:[^"]*\\)?|(?:[^"\s]*\\)?)(?:conhost|openconsole)\.exe(?:"|\s|$)/iu;

function discoverWindows(marker: string): Target[] {
  const table = windowsProcesses(marker);
  const shield = windowsAncestry(table);
  return table
    .filter(
      (entry) =>
        entry.marked &&
        !shield.has(entry.pid) &&
        !CONSOLE_HOST.test(entry.command),
    )
    .map(({ pid, start, command }) => ({ pid, start, command }));
}

/** Windows has no SIGTERM to a process without a console: each target is terminated at once. */
async function terminateWindows(
  found: readonly Target[],
  report: (line: string) => void,
): Promise<void> {
  const survivors = windowsTerminate(found, GRACE_MS);
  for (const target of found)
    if (!survivors.includes(target.pid))
      report(`stopped pid ${target.pid} (${target.command})`);
  if (survivors.length > 0)
    throw new Error(
      `antelopejs-lease: pid ${survivors.join(", ")} still running ${GRACE_MS / 1000} s after it was terminated`,
    );
}

const WINDOWS_STOPPER: Stopper = {
  discover: discoverWindows,
  terminate: terminateWindows,
};

/** Throws unless this platform is Linux or Windows, the ones where a process's environment can be read to find a lease's processes. */
export function assertStopSupported(): void {
  if (process.platform !== "linux" && process.platform !== "win32")
    throw new Error(
      "antelopejs-lease: down --stop reads the environment of each process and runs on Linux and Windows only; stop your servers with their own stop command, then run down",
    );
}

/**
 * Stops every process of this user whose environment holds `ANTELOPEJS_LEASE=<id>`, which `run`
 * exports and every descendant inherits, except this process and its ancestors. Signals each pid
 * alone, never a group: on Linux SIGTERM, a few seconds to exit, then SIGKILL; on Windows it
 * terminates each at once. The start time is checked again before each signal so a pid the system
 * reused is never signalled. Scans again after each pass, for processes started meanwhile. Calls
 * `report` with one line per process that stopped, and throws when one outlives the kill or new
 * ones keep appearing. Linux reads `/proc`; Windows reads each process's parameters.
 */
export async function stopOwn(
  id: LeaseId,
  report: (line: string) => void,
): Promise<void> {
  assertStopSupported();
  const marker = leaseMarker(id);
  const stopper =
    process.platform === "win32" ? WINDOWS_STOPPER : linuxStopper();
  for (let round = 0; round < ROUNDS; round += 1) {
    const found = stopper.discover(marker);
    if (found.length === 0) return;
    await stopper.terminate(found, report);
  }
  const left = stopper.discover(marker);
  if (left.length > 0)
    throw new Error(
      `antelopejs-lease: pid ${left.map((target) => target.pid).join(", ")} of this lease appeared after ${ROUNDS} rounds of --stop`,
    );
}
