import { spawn } from "node:child_process";
import { constants } from "node:os";

import { leaseEnv, type ServerRole } from "./env.ts";
import { ensureMongod, mongodPid, stopMongod } from "./mongo.ts";
import { accepting, listenerPids } from "./ports.ts";
import {
  isRole,
  leaseHome,
  PORT_ROLES,
  type LeaseRecord,
  type Role,
} from "./protocol.ts";
import {
  foreignRecord,
  locateWorktree,
  markRun,
  mongodPaths,
  openLease,
  readEntries,
  removeLease,
  sweep,
  withRegistryLock,
  type LeaseState,
  type Observed,
} from "./registry.ts";

const DOWN_GRACE_MS = 10_000;
const DAY_MS = 86_400_000;
const FORWARDED: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
const ROLES = Object.keys(PORT_ROLES).filter(isRole);

/** One lease as `status` reports it. */
export interface LeaseReport {
  readonly id: string;
  readonly state: string;
  readonly dir: string;
  readonly record: LeaseRecord | null;
  /** The pid of the lease's own mongod, when one runs. */
  readonly mongod: number | null;
  /** The roles whose port accepts connections. */
  readonly listening: readonly Role[];
  /** For an orphaned lease, the pids listening on its api and web ports, when readable. */
  readonly pids: readonly number[];
}

function execute(
  command: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const [file, ...args] = command;
  if (file === undefined)
    throw new Error("antelopejs-lease: run needs a command after --");
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: "inherit", env });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    for (const signal of FORWARDED) process.on(signal, forward);
    const settle = (code: number) => {
      for (const signal of FORWARDED) process.off(signal, forward);
      resolve(code);
    };
    child.once("error", (error) => {
      process.stderr.write(
        `antelopejs-lease: cannot run ${file}: ${error.message}\n`,
      );
      settle(127);
    });
    child.once("exit", (code, signal) =>
      settle(code ?? 128 + (signal === null ? 0 : constants.signals[signal])),
    );
  });
}

/**
 * Opens this worktree's lease, makes sure its mongod runs unless `DMS_MONGO_URL` names another
 * server, and runs `command` with the lease's environment. Answers the command's exit code.
 */
export async function run(
  command: readonly string[],
  as: ServerRole | undefined,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const worktree = locateWorktree(process.cwd());
  const lease = await openLease(
    leaseHome(env),
    worktree,
    env.DMS_MONGO_URL ? "external" : "owned",
  );
  markRun(lease.dir, process.pid);
  if (lease.record.mongo === "owned")
    await ensureMongod(lease.record.ports.mongo, mongodPaths(lease.dir), env);
  return execute(command, leaseEnv(lease, env, as));
}

function stateLabel(state: LeaseState): string {
  if (state.kind === "unreadable") return `${state.kind}:${state.code}`;
  return state.kind === "stale" || state.kind === "orphaned"
    ? `${state.kind}:${state.reason}`
    : state.kind;
}

async function listeningRoles(record: LeaseRecord): Promise<Role[]> {
  const roles: Role[] = [];
  for (const role of ROLES)
    if (await accepting(record.ports[role])) roles.push(role);
  return roles;
}

async function report(observed: Observed): Promise<LeaseReport> {
  const { entry, state } = observed;
  const record = entry.parsed?.kind === "current" ? entry.parsed.record : null;
  const base = { id: entry.id, state: stateLabel(state), dir: entry.dir };
  if (record === null)
    return { ...base, record, mongod: null, listening: [], pids: [] };
  const pids =
    state.kind === "orphaned"
      ? [record.ports.api, record.ports.web].flatMap(listenerPids)
      : [];
  return {
    ...base,
    record,
    mongod: mongodPid(mongodPaths(entry.dir).dbpath) ?? null,
    listening: await listeningRoles(record),
    pids,
  };
}

/** Every lease on the machine after sweeping stale ones. */
export async function status(env: NodeJS.ProcessEnv): Promise<LeaseReport[]> {
  const home = leaseHome(env);
  const kept = await withRegistryLock(() => sweep(home, { leftovers: false }));
  return Promise.all(kept.map(report));
}

function mongodCell(row: LeaseReport): string {
  if (row.record?.mongo === "external") return "external";
  return row.mongod === null ? "-" : String(row.mongod);
}

/** `status` as an aligned table, one lease per line; empty when there is no lease. */
export function statusTable(rows: readonly LeaseReport[]): string {
  if (rows.length === 0) return "";
  const cells = [
    ["ID", "STATE", "API", "WEB", "MONGO", "MONGOD", "WORKTREE"],
    ...rows.map((row) => [
      row.id,
      row.state,
      String(row.record?.ports.api ?? "-"),
      String(row.record?.ports.web ?? "-"),
      String(row.record?.ports.mongo ?? "-"),
      mongodCell(row),
      `${row.record?.worktree ?? row.dir}${row.pids.length ? ` (pids ${row.pids.join(", ")})` : ""}`,
    ]),
  ];
  const widths = cells[0]?.map((_, column) =>
    Math.max(...cells.map((line) => line[column]?.length ?? 0)),
  );
  return cells
    .map((line) =>
      line
        .map((cell, column) => cell.padEnd(widths?.[column] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .map((line) => `${line}\n`)
    .join("");
}

/**
 * Tears down this worktree's lease: stops its mongod and deletes its data, logs and tmp. Refuses
 * while its api or web port accepts, unless `force`. Does nothing when there is no lease.
 */
export async function down(
  env: NodeJS.ProcessEnv,
  force: boolean,
): Promise<void> {
  const worktree = locateWorktree(process.cwd());
  const entry = readEntries(leaseHome(env)).find(
    (candidate) => candidate.id === worktree.id,
  );
  if (entry === undefined) return;
  if (entry.parsed?.kind === "foreign") throw foreignRecord(entry.dir);
  const ports =
    entry.parsed?.kind === "current" ? entry.parsed.record.ports : undefined;
  if (ports !== undefined && !force) {
    const busy = [];
    for (const port of [ports.api, ports.web])
      if (await accepting(port)) busy.push(port);
    if (busy.length > 0)
      throw new Error(
        `antelopejs-lease: port ${busy.join(" and ")} of this lease still listens; stop the servers first (for dms-dev.sh: antelopejs-lease run -- bash <path to dms-dev.sh> stop), or pass --force`,
      );
  }
  await stopMongod(mongodPaths(entry.dir).dbpath, DOWN_GRACE_MS);
  await withRegistryLock(() => removeLease(entry.dir));
}

/**
 * Removes every lease left behind machine-wide: stale leases, directories with no record, and
 * leases with no running `run`, no mongod and no listening port that no `run` opened for
 * `idleDays`.
 */
export async function gc(
  env: NodeJS.ProcessEnv,
  idleDays: number,
): Promise<void> {
  const idleBefore = Date.now() - idleDays * DAY_MS;
  await withRegistryLock(() =>
    sweep(leaseHome(env), { leftovers: true, idleBefore }),
  );
}
