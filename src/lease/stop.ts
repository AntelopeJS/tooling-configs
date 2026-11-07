import { readdirSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { leaseMarker } from "./env.ts";
import { assertSignallable, identify } from "./procs.ts";
import type { LeaseId } from "./protocol.ts";

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

/**
 * Stops every process of this user whose environment holds `ANTELOPEJS_LEASE=<id>`, which `run`
 * exports and every descendant inherits, except this process and its ancestors. Signals each pid
 * alone, never a group: SIGTERM, a few seconds to exit, then SIGKILL, with the start time checked
 * again before each signal so a pid the system reused is never signalled. Scans again after each
 * pass, for processes forked meanwhile. Calls `report` with one line per process that stopped, and
 * throws when one outlives the kill or new ones keep appearing. Linux only: it reads `/proc`.
 */
export async function stopOwn(
  id: LeaseId,
  report: (line: string) => void,
): Promise<void> {
  if (process.platform !== "linux")
    throw new Error(
      "antelopejs-lease: down --stop reads /proc and runs on Linux only; stop your servers with their own stop command, then run down",
    );
  const marker = leaseMarker(id);
  const shield = ancestry();
  for (let round = 0; round < ROUNDS; round += 1) {
    const found = discover(marker, shield);
    if (found.length === 0) return;
    await terminate(found, report);
  }
  const left = discover(marker, shield);
  if (left.length > 0)
    throw new Error(
      `antelopejs-lease: pid ${left.map((target) => target.pid).join(", ")} of this lease appeared after ${ROUNDS} rounds of --stop`,
    );
}
