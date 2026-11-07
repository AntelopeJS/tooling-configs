import { setTimeout as sleep } from "node:timers/promises";

import { listenerPids } from "./ports.ts";
import { identify, type ProcessIdentity } from "./procs.ts";
import type { Ports } from "./protocol.ts";
import type { RecordedRun } from "./registry.ts";

const GRACE_MS = 5_000;
const KILL_WAIT_MS = 2_000;
const POLL_MS = 50;

/** One process this lease started, with the identity that must still hold when it is signalled. */
interface Target {
  readonly pid: number;
  readonly start: string;
  /** Signal the whole process group, which `pid` leads. */
  readonly group: boolean;
  readonly label: string;
}

/** The pids and process groups of this process and its ancestors, which no stop may signal. */
function shielded() {
  const pids = new Set<number>([process.pid]);
  const groups = new Set<number>();
  let at = identify(process.pid);
  while (at !== undefined && !pids.has(at.ppid)) {
    groups.add(at.pgid);
    pids.add(at.ppid);
    at = identify(at.ppid);
  }
  return { pids, groups };
}

function ownedBy(found: ProcessIdentity): boolean {
  return found.uid === process.getuid?.();
}

/**
 * The live `run` processes of the lease whose recorded start time still matches, and the processes
 * listening on its api and web ports. A run that leads its process group is stopped as a group.
 * Never another user's process, this process, or one of its ancestors.
 */
function discover(
  runs: readonly RecordedRun[],
  ports: Pick<Ports, "api" | "web">,
): Target[] {
  const shield = shielded();
  const targets = new Map<number, Target>();
  for (const run of runs) {
    const found = identify(run.pid);
    if (found === undefined || run.start === "" || found.start !== run.start)
      continue;
    if (!ownedBy(found) || shield.pids.has(found.pid)) continue;
    const group = found.pgid === found.pid && !shield.groups.has(found.pgid);
    targets.set(found.pid, {
      pid: found.pid,
      start: found.start,
      group,
      label: group ? "run, process group" : "run",
    });
  }
  for (const role of ["api", "web"] as const)
    for (const pid of listenerPids(ports[role])) {
      const found = identify(pid);
      if (found === undefined || targets.has(pid)) continue;
      if (!ownedBy(found) || shield.pids.has(pid)) continue;
      targets.set(pid, {
        pid,
        start: found.start,
        group: false,
        label: `listening on ${role} port ${ports[role]}`,
      });
    }
  return [...targets.values()];
}

/**
 * Whether `target` is still the process it was found as. A group counts while it has a member and
 * its leader, if still there, is the recorded process: the system hands a pid out again only once
 * its group is empty.
 */
function alive(target: Target): boolean {
  const leader = identify(target.pid);
  if (leader !== undefined) return leader.start === target.start;
  if (!target.group) return false;
  try {
    process.kill(-target.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signal(target: Target, name: NodeJS.Signals): void {
  if (!alive(target)) return;
  try {
    process.kill(target.group ? -target.pid : target.pid, name);
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

/**
 * Stops what the lease started, and nothing else: the recorded `run` processes whose start time
 * still matches, as process groups where they lead one, and the processes listening on the api and
 * web ports. SIGTERM, a few seconds to exit, then SIGKILL; each target is checked again before each
 * signal, so a pid the system reused in between is never signalled. Calls `report` with one line
 * per process that stopped, and throws when one outlives the kill.
 */
export async function stopOwn(
  runs: readonly RecordedRun[],
  ports: Pick<Ports, "api" | "web">,
  report: (line: string) => void,
): Promise<void> {
  const found = discover(runs, ports);
  for (const target of found) signal(target, "SIGTERM");
  const stubborn = await untilGone(found, GRACE_MS);
  for (const target of stubborn) signal(target, "SIGKILL");
  const survivors = await untilGone(stubborn, KILL_WAIT_MS);
  for (const target of found)
    if (!survivors.includes(target))
      report(`stopped pid ${target.pid} (${target.label})`);
  if (survivors.length > 0)
    throw new Error(
      `antelopejs-lease: pid ${survivors.map((target) => target.pid).join(", ")} still running ${KILL_WAIT_MS / 1000} s after SIGKILL`,
    );
}
