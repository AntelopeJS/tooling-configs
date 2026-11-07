import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { accepting, listenerPids, listensOn } from "./ports.ts";
import { assertSignallable } from "./procs.ts";

const READY_TIMEOUT_MS = 30_000;
const KILL_WAIT_MS = 2_000;
const POLL_MS = 50;
const CACHED_BINARY = /^mongod-.+-(\d+)\.(\d+)\.(\d+)$/u;

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

/**
 * The mongod a lease runs: `MONGOMS_SYSTEM_BINARY`, else `mongod` on `PATH`, else the newest
 * mongodb-memory-server download in `MONGOMS_DOWNLOAD_DIR` or `~/.cache/mongodb-binaries`.
 */
export function findMongod(env: NodeJS.ProcessEnv): string | undefined {
  const system = env.MONGOMS_SYSTEM_BINARY;
  if (system && executable(system)) return system;
  const onPath = (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, "mongod"))
    .find(executable);
  return (
    onPath ??
    newestCached(
      env.MONGOMS_DOWNLOAD_DIR || join(homedir(), ".cache", "mongodb-binaries"),
    )
  );
}

/** The command line of `pid`, empty once the process has exited, a zombie included. */
function commandLine(pid: number): string {
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
 * The pid of the mongod serving `dbpath`, read from the `mongod.lock` mongod writes there. A pid is
 * trusted only while its command line names `dbpath`, so a reused pid never counts.
 */
export function mongodPid(dbpath: string): number | undefined {
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

/** Waits for the process itself: mongod empties `mongod.lock` before it exits. */
async function untilGone(
  pid: number,
  dbpath: string,
  ms: number,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (serves(pid, dbpath) && Date.now() < deadline) await sleep(POLL_MS);
  return !serves(pid, dbpath);
}

function signal(pid: number, name: NodeJS.Signals): void {
  assertSignallable(pid);
  try {
    process.kill(pid, name);
  } catch {
    return;
  }
}

/**
 * Stops the mongod serving `dbpath`, if any: SIGTERM and `graceMs` to shut down, then SIGKILL.
 * With `graceMs` 0 it kills at once. Throws when the process outlives the kill.
 */
export async function stopMongod(
  dbpath: string,
  graceMs: number,
): Promise<void> {
  const pid = mongodPid(dbpath);
  if (pid === undefined) return;
  if (graceMs > 0) {
    signal(pid, "SIGTERM");
    if (await untilGone(pid, dbpath, graceMs)) return;
  }
  signal(pid, "SIGKILL");
  if (await untilGone(pid, dbpath, KILL_WAIT_MS)) return;
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
 * With `--fork`, mongod daemonizes itself, and the process this call starts exits once the server
 * accepts connections. The server is never a child of this process, nor of the command `run`
 * becomes, which would keep it as a zombie after `down`. Two callers at once are safe: mongod locks its dbpath, so the second exits and both wait
 * for the first.
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
  const started = spawn(
    binary,
    [
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
      "--fork",
    ],
    { detached: true, stdio: "ignore" },
  );
  let exited = false;
  started.once("exit", () => (exited = true));
  started.once("error", () => (exited = true));
  started.unref();
  return ready(port, paths, () => exited);
}
