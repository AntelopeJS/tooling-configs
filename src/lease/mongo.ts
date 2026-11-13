import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { unmarked } from "./env.ts";
import { locateWindows } from "./exec.ts";
import { accepting, listenerPids, listensOn } from "./ports.ts";
import { assertSignallable } from "./procs.ts";
import {
  windowsProcesses,
  windowsStart,
  windowsTerminate,
  type WindowsProcess,
} from "./windows.ts";

const READY_TIMEOUT_MS = 30_000;
const KILL_WAIT_MS = 2_000;
const POLL_MS = 50;
const STAT_START = 19;
const DEAD_STATES = new Set(["Z", "X"]);
const CACHED_BINARY = /^mongod-.+-(\d+)\.(\d+)\.(\d+)(?:\.exe)?$/u;

/** Where a lease's mongod keeps its data and its log. */
export interface MongodPaths {
  readonly dbpath: string;
  readonly log: string;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function versionOf(name: string): number[] {
  return (CACHED_BINARY.exec(name) ?? []).slice(1).map(Number);
}

function byNewestVersion(left: string, right: string): number {
  const a = versionOf(left);
  const b = versionOf(right);
  const index = a.findIndex((part, at) => part !== b[at]);
  return index === -1 ? 0 : (b[index] ?? 0) - (a[index] ?? 0);
}

function newestCached(directory: string): string | undefined {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return undefined;
  }
  return names
    .filter((name) => CACHED_BINARY.test(name))
    .sort(byNewestVersion)
    .map((name) => join(directory, name))
    .find(executable);
}

function onPath(env: NodeJS.ProcessEnv): string | undefined {
  if (process.platform === "win32") {
    const found = locateWindows("mongod", env);
    return found.kind === "start" && !found.script ? found.file : undefined;
  }
  return (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, "mongod"))
    .find(executable);
}

/**
 * The mongod a lease runs: `MONGOMS_SYSTEM_BINARY`, else `mongod` on `PATH`, else the newest
 * mongodb-memory-server download in `MONGOMS_DOWNLOAD_DIR` or `~/.cache/mongodb-binaries`.
 */
export function findMongod(env: NodeJS.ProcessEnv): string | undefined {
  const system = env.MONGOMS_SYSTEM_BINARY;
  if (system && executable(system)) return system;
  return (
    onPath(env) ??
    newestCached(
      env.MONGOMS_DOWNLOAD_DIR || join(homedir(), ".cache", "mongodb-binaries"),
    )
  );
}

/** The command line of `pid`, empty once the process has exited, a zombie included. */
function commandLine(pid: number): string {
  if (process.platform === "win32")
    return windowsProcesses().find((entry) => entry.pid === pid)?.command ?? "";
  try {
    if (process.platform === "linux")
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

/**
 * The Windows process whose command line names `dbpath`. mongod holds its `mongod.lock` there
 * unreadable, so the command line is the only record of which process serves the dbpath.
 */
function windowsMongod(dbpath: string): WindowsProcess | undefined {
  return windowsProcesses().find((entry) => entry.command.includes(dbpath));
}

/**
 * The pid of the mongod serving `dbpath`, read from the `mongod.lock` mongod writes there, or on
 * Windows found by its command line. A pid is trusted only while its command line names `dbpath`,
 * so a reused pid never counts.
 */
export function mongodPid(dbpath: string): number | undefined {
  if (process.platform === "win32") return windowsMongod(dbpath)?.pid;
  let text: string;
  try {
    text = readFileSync(join(dbpath, "mongod.lock"), "utf8").trim();
  } catch {
    return undefined;
  }
  const pid = Number(text);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return serves(pid, dbpath) ? pid : undefined;
}

function serves(pid: number, dbpath: string): boolean {
  return commandLine(pid).includes(dbpath);
}

/** The fields of `/proc/<path>/stat` after the command name, the state first; `undefined` when it cannot be read. */
function statFields(path: string): string[] | undefined {
  try {
    const stat = readFileSync(`/proc/${path}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch {
    return undefined;
  }
}

/** True while some thread of `pid` has not exited, a main thread that exited before the others included. */
function anyThreadRuns(pid: number): boolean {
  let tids: string[];
  try {
    tids = readdirSync(`/proc/${pid}/task`);
  } catch {
    return false;
  }
  return tids.some((tid) => {
    const state = statFields(`${pid}/task/${tid}`)?.[0];
    return state !== undefined && !DEAD_STATES.has(state);
  });
}

/**
 * A check that answers whether the mongod `pid` serving `dbpath` still runs. On Linux it holds
 * until no thread of the process started at the same time as `pid` now runs: the command line
 * reads empty from the moment mongod drops its memory, while its threads still hold its port. A
 * reused pid has another start time. Elsewhere it holds while the command line names `dbpath`.
 */
function runningCheck(pid: number, dbpath: string): () => boolean {
  if (process.platform !== "linux") return () => serves(pid, dbpath);
  const start = statFields(String(pid))?.[STAT_START];
  return () =>
    start !== undefined &&
    statFields(String(pid))?.[STAT_START] === start &&
    anyThreadRuns(pid);
}

/** Waits up to `ms` for `runs` to answer false; answers whether it did. */
async function untilGone(runs: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (runs() && Date.now() < deadline) await sleep(POLL_MS);
  return !runs();
}

function signal(pid: number, name: NodeJS.Signals): void {
  assertSignallable(pid);
  try {
    process.kill(pid, name);
  } catch {
    return;
  }
}

/** Terminates the mongod serving `dbpath` on Windows, which has no SIGTERM for a process without a console. */
function stopWindowsMongod(dbpath: string): void {
  const found = windowsMongod(dbpath);
  if (found === undefined) return;
  if (windowsTerminate([found], KILL_WAIT_MS).length > 0)
    throw new Error(
      `antelopejs-lease: mongod ${found.pid} was still running ${KILL_WAIT_MS / 1000} s after it was terminated`,
    );
}

/**
 * Stops the mongod serving `dbpath`, if any: SIGTERM and `graceMs` to shut down, then SIGKILL.
 * With `graceMs` 0 it kills at once. Throws when the process outlives the kill.
 */
export async function stopMongod(
  dbpath: string,
  graceMs: number,
): Promise<void> {
  if (process.platform === "win32") return stopWindowsMongod(dbpath);
  const pid = mongodPid(dbpath);
  if (pid === undefined) return;
  const runs = runningCheck(pid, dbpath);
  if (!runs()) return;
  if (graceMs > 0) {
    signal(pid, "SIGTERM");
    if (await untilGone(runs, graceMs)) return;
  }
  signal(pid, "SIGKILL");
  if (await untilGone(runs, KILL_WAIT_MS)) return;
  throw new Error(
    `antelopejs-lease: mongod ${pid} was still running ${KILL_WAIT_MS / 1000} s after SIGKILL`,
  );
}

async function holder(port: number): Promise<string> {
  const pids = listenerPids(port);
  if (pids.length > 0) return `, held by pid ${pids.join(", ")}`;
  return (await accepting(port)) ? ", held by another process" : "";
}

/** The command lines of the processes this user may read. */
function commandLines(): string[] {
  if (process.platform === "win32")
    return windowsProcesses().map((entry) => entry.command);
  if (process.platform === "linux")
    return readdirSync("/proc")
      .filter((name) => /^\d+$/u.test(name))
      .map((name) => commandLine(Number(name)));
  try {
    return execFileSync("ps", ["-axo", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).split("\n");
  } catch {
    return [];
  }
}

function starting(dbpath: string): boolean {
  const argument = `--dbpath ${dbpath} `;
  return commandLines().some((line) => line.includes(argument));
}

/**
 * Waits until the mongod this call started with `--fork` has exited and the lease's own mongod
 * serves: the pid in `mongod.lock`, whose command line names the dbpath, listens on `port`. A
 * foreign listener on `port` never counts. Gives up once no process runs mongod on the dbpath: a
 * second mongod on the same dbpath can exit before the first has written its pid, so two runs at
 * once wait for the first.
 */
async function ready(
  port: number,
  paths: MongodPaths,
  exited: () => boolean,
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited()) {
      const pid = mongodPid(paths.dbpath);
      if (pid !== undefined && (await listensOn(pid, port))) return;
      if (pid === undefined && !starting(paths.dbpath)) break;
    }
    await sleep(POLL_MS);
  }
  throw new Error(
    `antelopejs-lease: mongod did not answer on port ${port}${await holder(port)}; see ${paths.log}`,
  );
}

/**
 * Makes sure the lease's own mongod serves `paths.dbpath` on `port`, starting one when none does.
 * The server is never a child of this process, nor of the command `run` becomes, which would keep
 * it as a zombie after `down`. On Linux and macOS mongod daemonizes itself with `--fork`, and the
 * process this call starts exits once the server accepts connections. Windows has no `--fork`, so
 * mongod starts there detached, with no console and no handle of this process. Two callers at once
 * are safe: mongod locks its dbpath, so the second exits and both wait for the first. mongod gets
 * no `ANTELOPEJS_LEASE`, even when the caller runs under another worktree's lease, so only `down`
 * of its own lease stops it.
 */
export async function ensureMongod(
  port: number,
  paths: MongodPaths,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (mongodPid(paths.dbpath) !== undefined)
    return ready(port, paths, () => true);
  const binary = findMongod(env);
  if (binary === undefined)
    throw new Error(
      "antelopejs-lease: no mongod on PATH or in ~/.cache/mongodb-binaries; install MongoDB, or set DMS_MONGO_URL to a server you run",
    );
  const args = [
    "--dbpath",
    paths.dbpath,
    "--port",
    String(port),
    "--bind_ip",
    "127.0.0.1",
    "--logpath",
    paths.log,
    "--logappend",
    "--wiredTigerCacheSizeGB",
    "0.25",
  ];
  if (process.platform === "win32") {
    windowsStart(binary, args);
    return ready(port, paths, () => true);
  }
  const started = spawn(binary, [...args, "--fork"], {
    detached: true,
    stdio: "ignore",
    env: unmarked(process.env),
  });
  let exited = false;
  started.once("exit", () => (exited = true));
  started.once("error", () => (exited = true));
  started.unref();
  return ready(port, paths, () => exited);
}
