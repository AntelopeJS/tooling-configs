import type { ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const POLL_MS = 50;

/** How long {@link stopProcessGroup} waits at each stage. */
export interface StopOptions {
  /** How long the group has to exit after the interrupt before it is killed. */
  graceMs: number;
  /** How long the group has to disappear after the kill before the stop fails. */
  killWaitMs: number;
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(
  started: ChildProcess,
  pid: number,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-pid, signal);
  } catch {
    started.kill(signal);
  }
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (groupAlive(pid) && Date.now() < deadline) await sleep(POLL_MS);
  return !groupAlive(pid);
}

/**
 * Interrupts a detached child's whole process group and answers once no process of the group is left,
 * so the files it was writing can be removed. A group still alive after `graceMs` is killed, and the
 * stop fails when the group is still there `killWaitMs` after the kill.
 */
export async function stopProcessGroup(
  started: ChildProcess,
  options: StopOptions,
): Promise<void> {
  const { pid } = started;
  if (pid === undefined) return;
  signalGroup(started, pid, "SIGINT");
  if (await goneWithin(pid, options.graceMs)) return;
  signalGroup(started, pid, "SIGKILL");
  if (await goneWithin(pid, options.killWaitMs)) return;
  throw new Error(
    `process group ${pid} was still running ${options.killWaitMs / 1000}s after SIGKILL`,
  );
}
