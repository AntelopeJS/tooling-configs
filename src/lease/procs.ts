import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

/**
 * Who a live process is. `start` changes whenever the system hands the same pid to another process,
 * so a pid recorded with its `start` is trusted only while both still match.
 */
export interface ProcessIdentity {
  readonly pid: number;
  /** The boot id and the start time in clock ticks on Linux, `ps` `lstart` on macOS. */
  readonly start: string;
  readonly uid: number;
  readonly pgid: number;
  readonly ppid: number;
}

const STAT_AFTER_COMM = 2;
const STAT_PPID = 1;
const STAT_PGID = 2;
const STAT_START = 19;
const DEAD_STATES = new Set(["Z", "X"]);

function fromProc(pid: number): ProcessIdentity | undefined {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + STAT_AFTER_COMM).split(" ");
  if (DEAD_STATES.has(fields[0] ?? "")) return undefined;
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  return {
    pid,
    start: `${boot}:${fields[STAT_START]}`,
    uid: statSync(`/proc/${pid}`).uid,
    pgid: Number(fields[STAT_PGID]),
    ppid: Number(fields[STAT_PPID]),
  };
}

function fromPs(pid: number): ProcessIdentity | undefined {
  const [uid, pgid, ppid, state, ...started] = execFileSync(
    "ps",
    ["-o", "uid=,pgid=,ppid=,stat=,lstart=", "-p", String(pid)],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  )
    .trim()
    .split(/\s+/u);
  if (state === undefined || DEAD_STATES.has(state.slice(0, 1)))
    return undefined;
  return {
    pid,
    start: started.join(" "),
    uid: Number(uid),
    pgid: Number(pgid),
    ppid: Number(ppid),
  };
}

/**
 * The identity of the live process `pid`; `undefined` when it does not exist, is a zombie, or the
 * platform cannot tell (anything but Linux and macOS).
 */
export function identify(pid: number): ProcessIdentity | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === "linux") return fromProc(pid);
    if (process.platform === "darwin") return fromPs(pid);
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Throws unless `pid` is an integer above 1. `process.kill` reads 0 as the caller's own process group, a negative number
 * as a group or, for -1, every process this user owns, and 1 is init, so none of them may reach a signal.
 */
export function assertSignallable(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 1)
    throw new Error(`antelopejs-lease: refusing to signal pid ${String(pid)}`);
}
