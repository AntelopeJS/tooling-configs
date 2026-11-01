import type { ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const POLL_MS = 50;

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

/**
 * Interrupts a detached child's whole process group and answers once no process of the group is left,
 * so the files it was writing can be removed. A group still alive after `graceMs` is killed.
 */
export async function stopProcessGroup(
  started: ChildProcess,
  graceMs: number,
): Promise<void> {
  const { pid } = started;
  if (pid === undefined) return;
  signalGroup(started, pid, "SIGINT");
  const deadline = Date.now() + graceMs;
  while (groupAlive(pid) && Date.now() < deadline) await sleep(POLL_MS);
  if (!groupAlive(pid)) return;
  signalGroup(started, pid, "SIGKILL");
  while (groupAlive(pid)) await sleep(POLL_MS);
}
