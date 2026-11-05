import { type ChildProcess, spawn } from "node:child_process";

const KILL_GRACE_MS = 5000;

/** How a command ended: its exit status (`null` when a signal or a spawn error ended it) and its combined output. */
export interface CommandResult {
  status: number | null;
  output: string;
}

function stopGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/**
 * Runs `command` in its own process group and collects stdout and stderr together. When `signal` aborts, the group
 * gets SIGTERM, then SIGKILL after a grace period, so a step's own children stop with it.
 */
export function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<CommandResult> {
  const { cwd, env = process.env, signal } = options;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: process.platform === "win32",
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    const interrupt = () => {
      stopGroup(child, "SIGTERM");
      setTimeout(() => stopGroup(child, "SIGKILL"), KILL_GRACE_MS).unref();
    };
    if (signal?.aborted) interrupt();
    else signal?.addEventListener("abort", interrupt, { once: true });
    child.once("error", (error) => {
      signal?.removeEventListener("abort", interrupt);
      resolve({ status: null, output: `${error.message}\n` });
    });
    child.once("close", (code, killed) => {
      signal?.removeEventListener("abort", interrupt);
      const text = Buffer.concat(chunks).toString("utf8");
      resolve({
        status: code,
        output: `${text}${killed ? `Terminated by ${killed}\n` : ""}`,
      });
    });
  });
}
