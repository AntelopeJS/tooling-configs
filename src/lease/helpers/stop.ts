import { spawn } from "node:child_process";
import type { TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { accepting } from "../ports.ts";
import { assertSignallable, identify } from "../procs.ts";
import { firstLine, LEASE_ARGV, startCaptured, type Started } from "./cli.ts";

/** Prints its pid, then idles. */
export const WAITER = "console.log(process.pid); setInterval(() => {}, 1000)";

/** Prints its pid and the pid of a second process in the same process group that idles beside it. */
export const TREE = `const kid = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
console.log(process.pid + " " + kid.pid);
setInterval(() => {}, 1000);`;

const DAEMON = `if (process.env.IGNORE_TERM) process.on("SIGTERM", () => {});
require("node:net").createServer().listen(Number(process.env.LISTEN_PORT), "127.0.0.1");
setInterval(() => {}, 1000);`;

function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `pid` is a process that has not exited; a zombie has. Windows has no zombies and no
 * start time to read, so it only asks whether the pid exists.
 */
export function isLive(pid: number): boolean {
  return process.platform === "win32"
    ? exists(pid)
    : identify(pid) !== undefined;
}

/**
 * Kills `pid`, with its process group when it leads one, after the test, only while it is still
 * the process it was when this was called. On Windows it kills the one process: there are no
 * groups, and a pid cannot be told from a reused one.
 */
export function reap(t: TestContext, pid: number, group: boolean): void {
  assertSignallable(pid);
  if (process.platform === "win32") {
    t.after(() => {
      try {
        process.kill(pid);
      } catch {
        return;
      }
    });
    return;
  }
  const start = identify(pid)?.start;
  t.after(() => {
    if (start === undefined || identify(pid)?.start !== start) return;
    try {
      process.kill(group ? -pid : pid, "SIGKILL");
    } catch {
      return;
    }
  });
}

/** The pids a `down --stop` printed a `stopped pid` line for, in ascending order. */
export function stoppedPids(stdout: string): number[] {
  return [...stdout.matchAll(/^stopped pid (\d+) \(.*\)$/gmu)]
    .map((match) => Number(match[1]))
    .toSorted((a, b) => a - b);
}

/** A process that idles outside any lease, as its own process group, killed after the test. */
export function startWaiter(t: TestContext): number {
  const child = spawn(process.execPath, ["-e", WAITER], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const pid = child.pid ?? 0;
  reap(t, pid, true);
  return pid;
}

/**
 * A server that listens on `port` from a process group of its own, as a dev server that
 * daemonized does, killed after the test. With `stubborn` it ignores SIGTERM. With `lease` its
 * environment holds `ANTELOPEJS_LEASE=<lease>`, as a server a `run` of that lease started does.
 */
export async function startDaemon(
  t: TestContext,
  port: number,
  stubborn: boolean,
  lease?: string,
): Promise<number> {
  const child = spawn(process.execPath, ["-e", DAEMON], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ANTELOPEJS_LEASE: lease,
      LISTEN_PORT: String(port),
      IGNORE_TERM: stubborn ? "1" : "",
    },
  });
  child.unref();
  const pid = child.pid ?? 0;
  reap(t, pid, true);
  const deadline = Date.now() + 10_000;
  while (!(await accepting(port))) {
    if (Date.now() > deadline) throw new Error(`nothing listens on ${port}`);
    await sleep(20);
  }
  return pid;
}

/**
 * Starts `run -- node -e <script>` as the leader of its own process group and waits for its first
 * line. Killed after the test, with its group.
 */
export async function startRun(
  t: TestContext,
  cwd: string,
  env: NodeJS.ProcessEnv,
  script: string,
): Promise<{ readonly started: Started; readonly line: string }> {
  const [file = "", ...args] = [
    ...LEASE_ARGV,
    "run",
    "--",
    process.execPath,
    "-e",
    script,
  ];
  const started = startCaptured(file, args, { cwd, env, detached: true });
  reap(t, started.child.pid ?? 0, true);
  return { started, line: await firstLine(started) };
}
