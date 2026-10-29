import { type ChildProcess, spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, relative } from "node:path";

import { parseJson, type JsonValue } from "../garden/json.ts";
import type { CommandResult, HttpResult } from "./types.ts";

/** A command to drive: a program, its arguments and where it runs. */
export interface CommandSpec {
  program: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 600_000;

/** Quotes an argument the way a shell user would type it. */
function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, "'\\''")}'`;
}

function describe(spec: CommandSpec): string {
  return [spec.program, ...spec.args].map(shellQuote).join(" ");
}

function writeCommand(folder: string, spec: CommandSpec): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "command.txt"),
    `cd ${shellQuote(spec.cwd)}\n${describe(spec)}\n`,
  );
}

/** Runs a command to completion and writes command.txt, stdout.txt, stderr.txt and exit-code.txt into `folder`. */
export function runRecorded(
  folder: string,
  spec: CommandSpec,
): Promise<CommandResult> {
  writeCommand(folder, spec);
  return new Promise((resolve) => {
    const child = spawn(spec.program, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const finish = (
      code: number | null,
      signal: string | null,
      failure = "",
    ) => {
      clearTimeout(timer);
      const result: CommandResult = {
        folder,
        command: describe(spec),
        exitCode: code,
        signal,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: `${Buffer.concat(err).toString("utf8")}${failure}`,
      };
      writeFileSync(join(folder, "stdout.txt"), result.stdout);
      writeFileSync(join(folder, "stderr.txt"), result.stderr);
      writeFileSync(
        join(folder, "exit-code.txt"),
        `${code ?? `signal ${signal}`}\n`,
      );
      resolve(result);
    };
    child.on("error", (error) => finish(null, null, `${error.message}\n`));
    child.on("close", (code, signal) => finish(code, signal));
  });
}

/** A background command whose output streams into its evidence folder. */
export interface BackgroundHandle {
  folder: string;
  child: ChildProcess;
  pid: number;
  exited: Promise<{ exitCode: number | null; signal: string | null }>;
}

/** Starts a long-running command in its own process group, writing stdout and stderr straight to files. */
export function startRecorded(
  folder: string,
  spec: CommandSpec,
): BackgroundHandle {
  writeCommand(folder, spec);
  const stdout = openSync(join(folder, "stdout.txt"), "w");
  const stderr = openSync(join(folder, "stderr.txt"), "w");
  const child = spawn(spec.program, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    detached: true,
    stdio: ["ignore", stdout, stderr],
  });
  closeSync(stdout);
  closeSync(stderr);
  const exited = new Promise<{
    exitCode: number | null;
    signal: string | null;
  }>((resolve) => {
    child.on("exit", (exitCode, signal) => {
      writeFileSync(
        join(folder, "exit-code.txt"),
        `${exitCode ?? `signal ${signal}`}\n`,
      );
      resolve({ exitCode, signal });
    });
  });
  if (child.pid === undefined)
    throw new Error(`Could not start ${describe(spec)}`);
  writeFileSync(join(folder, "pid.txt"), `${child.pid}\n`);
  return { folder, child, pid: child.pid, exited };
}

/** Kills the process group of `pid`, or `pid` alone, ignoring a process already gone. */
export function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return;
    }
  }
}

/** What a background command has written so far. */
export interface Output {
  stdout: string;
  stderr: string;
}

/** Reads what a background command has written so far. */
export function readOutput(folder: string): Output {
  return {
    stdout: readFileSync(join(folder, "stdout.txt"), "utf8"),
    stderr: readFileSync(join(folder, "stderr.txt"), "utf8"),
  };
}

/** Asks the kernel for a free TCP port on the loopback interface. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        address !== null && address instanceof Object ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function reason(error: Error): string {
  return error.cause instanceof Error ? error.cause.message : error.message;
}

/** Sends one request and writes http.json with the status and body. */
export async function httpRecorded(
  folder: string,
  url: string,
  init: { method?: string; body?: string; timeoutMs?: number } = {},
): Promise<HttpResult> {
  mkdirSync(folder, { recursive: true });
  let result: HttpResult;
  try {
    const response = await fetch(url, {
      method: init.method ?? "GET",
      body: init.body,
      headers: init.body ? { "content-type": "application/json" } : undefined,
      signal: AbortSignal.timeout(init.timeoutMs ?? 5000),
    });
    const body = await response.text();
    let json: JsonValue | undefined;
    try {
      json = parseJson(body);
    } catch {
      json = undefined;
    }
    result = { folder, url, status: response.status, body, json, error: null };
  } catch (error) {
    result = {
      folder,
      url,
      status: null,
      body: "",
      json: undefined,
      error: error instanceof Error ? reason(error) : String(error),
    };
  }
  writeFileSync(
    join(folder, "http.json"),
    `${JSON.stringify({ request: { url, ...init }, response: result }, null, 2)}\n`,
  );
  return result;
}

const TREE_SKIP = new Set(["node_modules", ".git", ".pnpm-store"]);

function listTree(root: string, folder = root): string[] {
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => !TREE_SKIP.has(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(folder, entry.name);
      const name = relative(root, path);
      if (entry.isDirectory()) return [`${name}/`, ...listTree(root, path)];
      return [`${name} ${statSync(path).size}`];
    });
}

/** Writes `tree.txt`: every path under `root` with its size, node_modules and .git left out. */
export function recordTree(folder: string, root: string): string[] {
  mkdirSync(folder, { recursive: true });
  let lines: string[];
  try {
    lines = listTree(root);
  } catch {
    lines = [];
  }
  writeFileSync(join(folder, "tree.txt"), `${root}\n${lines.join("\n")}\n`);
  return lines;
}
