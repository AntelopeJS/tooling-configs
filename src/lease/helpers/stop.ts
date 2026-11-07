import { spawn } from "node:child_process";
import type { TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { accepting } from "../ports.ts";
import { identify } from "../procs.ts";
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

/** Whether `pid` is a process that has not exited; a zombie has. */
export function isLive(pid: number): boolean {
  return identify(pid) !== undefined;
}

function reap(t: TestContext, pid: number, group: boolean): void {
  t.after(() => {
    if (!isLive(pid)) return;
    try {
      process.kill(group ? -pid : pid, "SIGKILL");
    } catch {
      return;
    }
  });
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
 * daemonized does, killed after the test. With `stubborn` it ignores SIGTERM.
 */
export async function startDaemon(
  t: TestContext,
  port: number,
  stubborn: boolean,
): Promise<number> {
  const child = spawn(process.execPath, ["-e", DAEMON], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
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
  t.after(() => {
    if (started.child.exitCode === null && started.child.signalCode === null)
      process.kill(-(started.child.pid ?? 0), "SIGKILL");
  });
  return { started, line: await firstLine(started) };
}
