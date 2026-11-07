import { readOutput } from "./record.ts";
import type { App } from "./types.ts";

/** The signals a process outside the run sends to end an app. Any other signal, such as SIGABRT or SIGSEGV, is the product crashing. */
const OUTSIDE_KILLS: ReadonlySet<string> = new Set([
  "SIGKILL",
  "SIGTERM",
  "SIGHUP",
  "SIGINT",
]);

/** An app a journey started, the signals the harness sent it, and how it exited. */
export interface StartedApp {
  app: App;
  sent: string[];
  exit: { exitCode: number | null; signal: string | null } | null;
}

/**
 * Why one of the apps a journey started points away from the product, or
 * `null`: an app killed by SIGKILL, SIGTERM, SIGHUP or SIGINT that the harness
 * did not send, or an app that could not bind the port the harness gave it.
 */
export function appFault(started: readonly StartedApp[]): string | null {
  for (const { app, sent, exit } of started) {
    const label = `${app.name} (pid ${app.pid})`;
    if (
      exit?.signal &&
      OUTSIDE_KILLS.has(exit.signal) &&
      !sent.includes(exit.signal)
    )
      return `${label} was killed by ${exit.signal}, a signal the harness did not send`;
    const output = readOutput(app.folder);
    const port = new RegExp(`(?<![0-9])${app.port}(?![0-9])`);
    const taken = `${output.stdout}\n${output.stderr}`
      .split("\n")
      .find((line) => line.includes("EADDRINUSE") && port.test(line));
    if (taken !== undefined)
      return `${label} could not bind port ${app.port}, which another process holds: ${taken.trim().slice(0, 300)}`;
  }
  return null;
}
