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
const IGNORED_BY_NODE: readonly NodeJS.Signals[] = ["SIGPIPE", "SIGXFSZ"];
const EXEC = `command -v "$1" >/dev/null 2>&1 || { printf 'antelopejs-lease: cannot run %s: not found\\n' "$1" >&2; exit 127; }; exec "$@"`;
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
 * Replaces this process with `command`. The command keeps this pid and is the only process, so a
 * signal from a terminal, a process-group kill or `kill <pid>` reaches it once, and its exit
 * status, 128 plus the signal included, is the caller's. `/bin/sh` finds the command on `PATH`.
 * Node ignores SIGPIPE and SIGXFSZ, and an ignored signal stays ignored across `execve`, so both
 * get a handler first, which `execve` resets to the default.
 */
function execute(command: readonly string[], env: NodeJS.ProcessEnv): never {
  if (process.execve === undefined)
    throw new Error(
      "antelopejs-lease: run needs process.execve, from Node 22.15 on Linux or macOS",
    );
  for (const signal of IGNORED_BY_NODE) process.on(signal, () => undefined);
  return process.execve("/bin/sh", ["sh", "-c", EXEC, "sh", ...command], env);
}

/**
 * Opens this worktree's lease, makes sure its mongod runs unless `DMS_MONGO_URL` names another
 * server, and replaces this process with `command` under the lease's environment.
 */
export async function run(
  command: readonly string[],
  as: ServerRole | undefined,
  env: NodeJS.ProcessEnv,
): Promise<never> {
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
