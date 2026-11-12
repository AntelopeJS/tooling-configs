import { type ChildProcess, spawn } from "node:child_process";

const KILL_GRACE_MS = 5000;

/** How a command ended: its exit status (`null` when a signal or a spawn error ended it), its stdout, and stdout and stderr combined. */
export interface CommandResult {
  status: number | null;
  stdout: string;
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

const PLAIN_ARGUMENT = /^[\w./:\\@=+~,-]+$/u;

/** `argument` as cmd.exe passes it on whole: as it is when plain, else in double quotes, with a trailing backslash doubled so it does not escape the closing quote. Throws for a `"`, `%`, CR or LF, which cmd.exe would expand or split however it is quoted. */
export function windowsArgument(argument: string): string {
  if (PLAIN_ARGUMENT.test(argument)) return argument;
  if (/["%\r\n]/u.test(argument))
    throw new Error(
      `Cannot pass ${JSON.stringify(argument)} through cmd.exe, which would expand or split it.`,
    );
  return `"${argument.replace(/\\+$/u, "$&$&")}"`;
}

/**
 * How to spawn `command`, a name on `PATH` such as `pnpm`, with `args`. On Windows that is cmd.exe running one
 * quoted line, so the `.cmd` shim resolves and each argument stays whole without Node's deprecated `shell` option
 * with an argument array; elsewhere the command itself.
 */
export function shimInvocation(command: string, args: readonly string[]) {
  if (process.platform !== "win32")
    return { command, args: [...args], shell: false };
  return {
    command: [command, ...args].map(windowsArgument).join(" "),
    args: [],
    shell: true,
  };
}

/**
 * Runs `command` in its own process group and collects stdout and stderr together. When `signal` aborts, the group
 * gets SIGTERM, then SIGKILL after a grace period, so a step's own children stop with it. On Windows the command runs
 * through cmd.exe per {@link shimInvocation}, so `npm` and `pnpm` resolve to their `.cmd` shims, unless `shell` is
 * `false`: pass that for an executable path.
 */
export function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    shell?: boolean;
  },
): Promise<CommandResult> {
  const { cwd, env = process.env, signal, shell = true } = options;
  const invocation = shell
    ? shimInvocation(command, args)
    : { command, args, shell };
  return new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env,
      shell: invocation.shell,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    const interrupt = () => {
      stopGroup(child, "SIGTERM");
      setTimeout(() => stopGroup(child, "SIGKILL"), KILL_GRACE_MS).unref();
    };
    if (signal?.aborted) interrupt();
    else signal?.addEventListener("abort", interrupt, { once: true });
    child.once("error", (error) => {
      signal?.removeEventListener("abort", interrupt);
      resolve({ status: null, stdout: "", output: `${error.message}\n` });
    });
    child.once("close", (code, killed) => {
      signal?.removeEventListener("abort", interrupt);
      const text = Buffer.concat(chunks).toString("utf8");
      resolve({
        status: code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        output: `${text}${killed ? `Terminated by ${killed}\n` : ""}`,
      });
    });
  });
}
