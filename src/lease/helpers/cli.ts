import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  child,
  isObject,
  list,
  num,
  object,
  parseJson,
  str,
  type JsonObject,
  type JsonValue,
} from "../../garden/json.ts";
import { eachRole, type Ports } from "../protocol.ts";

const BIN = fileURLToPath(new URL("../../bin/lease.ts", import.meta.url));

/** Prints the lease variables the command sees, as one JSON object. */
const PRINT_ENV = `process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(ANTELOPEJS_LEASE|DMS_|MONGO_|PORT$|TMPDIR$)/.test(key)))))`;

/** What one bin invocation printed and how it exited. */
export interface Outcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** A bin invocation still running. */
export interface Started {
  readonly child: ChildProcess;
  readonly done: Promise<Outcome>;
  readonly stdout: () => string;
}

/** One `status --json` row, reduced to what the tests assert. */
export interface Row {
  readonly id: string;
  readonly state: string;
  readonly dir: string;
  readonly ports: Ports | undefined;
  readonly mongod: number | undefined;
  readonly pids: readonly number[];
}

/** A fresh directory under the system tmp, by real path, removed after the test. */
export function scratch(t: TestContext): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lease-test-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function gitInit(path: string): string {
  execFileSync("git", ["init", "-q", path]);
  return path;
}

/** The test process's environment pointed at `home`, without the variables a caller may carry. */
export function envFor(
  home: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const {
    DMS_MONGO_URL: _mongo,
    PORT: _port,
    ANTELOPEJS_LEASE_HOME: _home,
    ...rest
  } = process.env;
  return { ...rest, ANTELOPEJS_LEASE_HOME: home, ...extra };
}

/** The environment of a run that uses an outside Mongo, so no mongod starts. */
export function externalEnv(home: string): NodeJS.ProcessEnv {
  return envFor(home, { DMS_MONGO_URL: "mongodb://127.0.0.1:1" });
}

/** Starts one bin invocation and leaves it running. */
export function startLease(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Started {
  const started = spawn(process.execPath, [BIN, ...args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  started.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  started.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const done = new Promise<Outcome>((resolve) =>
    started.once("close", (code) => resolve({ code, stdout, stderr })),
  );
  return { child: started, done, stdout: () => stdout };
}

export function lease(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<Outcome> {
  return startLease(args, cwd, env).done;
}

/** Waits until `started` has printed a line, and answers that line. Throws after 10 s. */
export async function firstLine(started: Started): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (!started.stdout().includes("\n")) {
    if (Date.now() > deadline || started.child.exitCode !== null)
      throw new Error(
        `no line printed; got ${JSON.stringify(started.stdout())}`,
      );
    await sleep(20);
  }
  return started.stdout().split("\n")[0] ?? "";
}

/** The JSON object a `run -- <print env>` printed. */
export function envOf(outcome: Outcome): JsonObject {
  if (outcome.code !== 0)
    throw new Error(`run exited ${outcome.code}: ${outcome.stderr}`);
  return object(parseJson(outcome.stdout), "env");
}

/** The lease variables `run [runArgs] --` hands its command in `cwd`. */
export async function leasedEnv(
  cwd: string,
  env: NodeJS.ProcessEnv,
  runArgs: readonly string[] = [],
): Promise<JsonObject> {
  return envOf(
    await lease(
      ["run", ...runArgs, "--", process.execPath, "-e", PRINT_ENV],
      cwd,
      env,
    ),
  );
}

/** Starts `run -- <print env>` and leaves it running. */
export function startLeasedEnv(cwd: string, env: NodeJS.ProcessEnv): Started {
  return startLease(["run", "--", process.execPath, "-e", PRINT_ENV], cwd, env);
}

function field(source: JsonObject, key: string): JsonValue | undefined {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}

function decodeRow(value: JsonObject): Row {
  const record = field(value, "record");
  const ports =
    record !== undefined && isObject(record)
      ? child(record, "ports")
      : undefined;
  const mongod = field(value, "mongod");
  return {
    id: str(value, "id"),
    state: str(value, "state"),
    dir: str(value, "dir"),
    ports:
      ports === undefined ? undefined : eachRole((role) => num(ports, role)),
    mongod: mongod === null ? undefined : num(value, "mongod"),
    pids: list(field(value, "pids") ?? [], "pids").map(Number),
  };
}

/** The rows of `status --json`. */
export async function statusRows(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<Row[]> {
  const outcome = await lease(["status", "--json"], cwd, env);
  if (outcome.code !== 0)
    throw new Error(`status exited ${outcome.code}: ${outcome.stderr}`);
  return list(parseJson(outcome.stdout), "status").map((row) =>
    decodeRow(object(row, "row")),
  );
}
