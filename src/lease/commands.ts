import { leaseEnv, leaseMarker, type ServerRole } from "./env.ts";
import { launch } from "./exec.ts";
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
import { assertStopSupported, stopOwn } from "./stop.ts";

const DOWN_GRACE_MS = 10_000;
const DAY_MS = 86_400_000;
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

/**
 * Opens this worktree's lease, makes sure its mongod runs unless `DMS_MONGO_URL` names another
 * server, and runs `command` under the lease's environment: as this process on Linux and macOS, as
 * a child of it on Windows. Answers 127 or 126, as a shell does, when the command is not found or
 * cannot run, and the command's own exit code on Windows.
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
  return launch(command, leaseEnv(lease, env, as));
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

/** A running mongod shows its pid in every mode, so a lease switched to `DMS_MONGO_URL` hides none. */
function mongodCell(row: LeaseReport): string {
  if (row.mongod !== null) return String(row.mongod);
  return row.record?.mongo === "external" ? "external" : "-";
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

/** What `down` may do beyond the teardown itself. */
export interface DownOptions {
  /** Tear down although the api or web port still listens. */
  readonly force: boolean;
  /**
   * Stop the processes this lease started first, and call this once per process stopped. Absent:
   * stop nothing, and refuse while a port listens.
   */
  readonly stop?: (line: string) => void;
}

function stillListens(
  record: LeaseRecord,
  busy: readonly number[],
  stopped: boolean,
): Error {
  const ports = busy.join(" and ");
  if (!stopped)
    return new Error(
      `antelopejs-lease: port ${ports} of this lease still listens; stop what this worktree started with antelopejs-lease down --stop, or pass --force to tear down anyway`,
    );
  const pids = busy.flatMap(listenerPids);
  const holder =
    pids.length > 0
      ? `pid ${pids.join(", ")}`
      : "a process this user cannot inspect";
  return new Error(
    `antelopejs-lease: port ${ports} of this lease still listens after --stop, held by ${holder} without ${leaseMarker(record.id)} in its environment, so not started by this lease and left running; pass --force to tear down anyway`,
  );
}

/**
 * Tears down this worktree's lease: stops its mongod and deletes its data, logs and tmp. With
 * `stop`, first stops the processes the lease started. Refuses while its api or web port accepts,
 * unless `force`. Does nothing when there is no lease.
 */
export async function down(
  env: NodeJS.ProcessEnv,
  options: DownOptions,
): Promise<void> {
  const worktree = locateWorktree(process.cwd());
  const entry = readEntries(leaseHome(env)).find(
    (candidate) => candidate.id === worktree.id,
  );
  if (entry === undefined) return;
  if (options.stop !== undefined) assertStopSupported();
  if (entry.parsed?.kind === "foreign") throw foreignRecord(entry.dir);
  const record =
    entry.parsed?.kind === "current" ? entry.parsed.record : undefined;
  if (record !== undefined && options.stop !== undefined)
    await stopOwn(record.id, options.stop);
  if (record !== undefined && !options.force) {
    const busy = [];
    for (const port of [record.ports.api, record.ports.web])
      if (await accepting(port)) busy.push(port);
    if (busy.length > 0)
      throw stillListens(record, busy, options.stop !== undefined);
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
