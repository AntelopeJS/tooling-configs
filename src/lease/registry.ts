import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { Lease } from "./env.ts";
import { mongodPid, stopMongod, type MongodPaths } from "./mongo.ts";
import {
  accepting,
  bindable,
  chooseBlock,
  claimPort,
  closeServer,
  listenerPids,
} from "./ports.ts";
import {
  isLeaseId,
  LOCK_PORT,
  leaseId,
  parseRecord,
  type GitIdentity,
  type LeaseId,
  type LeaseRecord,
  type MongoMode,
  type ParsedRecord,
} from "./protocol.ts";

const LOCK_WAIT_MS = 15_000;
const RECORD_FILE = "lease.json";

/** The git worktree a command runs in. */
export interface Worktree {
  readonly path: string;
  readonly id: LeaseId;
  readonly git: GitIdentity;
}

/** Why a lease no longer belongs to a checkout: its path is gone, or holds a new checkout. */
type StaleReason = "missing" | "recreated";

/**
 * Where a lease stands. `orphaned` is a stale lease whose api or web port still accepts: its block
 * stays reserved and nothing is killed. `claiming` is a directory with no record yet: a claim in
 * progress, or a crash leftover. `foreign` is a record this version cannot read.
 */
export type LeaseState =
  | { readonly kind: "live" }
  | { readonly kind: "stale"; readonly reason: StaleReason }
  | { readonly kind: "orphaned"; readonly reason: StaleReason }
  | { readonly kind: "claiming" }
  | { readonly kind: "foreign" };

/** What the filesystem and the network say about a lease right now. */
export interface LeaseFacts {
  /** The `.git` entry now at the record's worktree path; `undefined` when there is none. */
  readonly git: GitIdentity | undefined;
  /** Whether the api or web port accepts connections. */
  readonly serving: boolean;
}

/** One lease directory and what it held when read. */
export interface Entry {
  readonly id: LeaseId;
  readonly dir: string;
  readonly parsed: ParsedRecord | undefined;
}

/** An entry and the state it was in when observed. */
export interface Observed {
  readonly entry: Entry;
  readonly state: LeaseState;
}

/** Which leases a sweep removes beside stale ones. */
export interface SweepPolicy {
  /** Remove directories with no record. Safe only under the lock, where no claim is in progress. */
  readonly leftovers: boolean;
  /** Remove live leases with no mongod and no listening port, untouched since this epoch time. */
  readonly idleBefore?: number;
}

function staleReason(
  record: LeaseRecord,
  git: GitIdentity | undefined,
): StaleReason | undefined {
  if (git === undefined) return "missing";
  if (git.inode !== record.gitInode) return "recreated";
  const births = git.birth !== 0 && record.gitBirth !== 0;
  return births && git.birth !== record.gitBirth ? "recreated" : undefined;
}

/** The state of a lease from its parsed record and the facts observed about it. */
export function leaseState(
  parsed: ParsedRecord | undefined,
  facts: LeaseFacts,
): LeaseState {
  if (parsed === undefined) return { kind: "claiming" };
  if (parsed.kind === "foreign") return { kind: "foreign" };
  const reason = staleReason(parsed.record, facts.git);
  if (reason === undefined) return { kind: "live" };
  return { kind: facts.serving ? "orphaned" : "stale", reason };
}

/** The identity of the `.git` entry in `worktree`; `undefined` when there is none. */
function gitIdentity(worktree: string): GitIdentity | undefined {
  try {
    const stat = statSync(join(worktree, ".git"));
    return { inode: stat.ino, birth: stat.birthtimeMs };
  } catch {
    return undefined;
  }
}

/** The worktree containing `cwd`, by the real path of `git rev-parse --show-toplevel`. */
export function locateWorktree(cwd: string): Worktree {
  let top: string;
  try {
    top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(`antelopejs-lease: ${cwd} is not inside a git worktree`);
  }
  const path = realpathSync(top);
  const git = gitIdentity(path);
  if (git === undefined)
    throw new Error(`antelopejs-lease: ${path} has no .git entry`);
  return { path, id: leaseId(path), git };
}

export function mongodPaths(dir: string): MongodPaths {
  return { dbpath: join(dir, "mongo"), log: join(dir, "logs", "mongod.log") };
}

/**
 * Runs `body` holding the registry lock: a listener on 127.0.0.1:{@link LOCK_PORT}. The kernel
 * frees it when its holder exits, crash included, so the lock never goes stale. Waits up to 15 s.
 */
export async function withRegistryLock<T>(body: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let server = await claimPort(LOCK_PORT, "127.0.0.1");
  while (server === undefined) {
    if (Date.now() > deadline)
      throw new Error(
        `antelopejs-lease: registry lock 127.0.0.1:${LOCK_PORT} held for ${LOCK_WAIT_MS / 1000} s; find its holder with: ss -ltnp 'sport = :${LOCK_PORT}' or lsof -iTCP:${LOCK_PORT} -sTCP:LISTEN`,
      );
    await sleep(20 + Math.random() * 20);
    server = await claimPort(LOCK_PORT, "127.0.0.1");
  }
  try {
    return await body();
  } finally {
    await closeServer(server);
  }
}

function readParsed(dir: string): ParsedRecord | undefined {
  let text: string;
  try {
    text = readFileSync(join(dir, RECORD_FILE), "utf8");
  } catch {
    return undefined;
  }
  return parseRecord(text);
}

/** Every lease directory under `home`. */
export function readEntries(home: string): Entry[] {
  let names: string[];
  try {
    names = readdirSync(home);
  } catch {
    return [];
  }
  return names.filter(isLeaseId).map((id) => {
    const dir = join(home, id);
    return { id, dir, parsed: readParsed(dir) };
  });
}

/** The ports an entry keeps from every other lease. */
function reservedBy(entry: Entry): readonly number[] {
  if (entry.parsed === undefined) return [];
  if (entry.parsed.kind === "foreign") return entry.parsed.reserved;
  return Object.values(entry.parsed.record.ports);
}

async function serving(record: LeaseRecord): Promise<boolean> {
  return (await accepting(record.ports.api)) || accepting(record.ports.web);
}

async function observe(entry: Entry): Promise<Observed> {
  const record =
    entry.parsed?.kind === "current" ? entry.parsed.record : undefined;
  const facts =
    record === undefined
      ? { git: undefined, serving: false }
      : { git: gitIdentity(record.worktree), serving: await serving(record) };
  return { entry, state: leaseState(entry.parsed, facts) };
}

/** Kills the lease's mongod, then deletes its directory. Call under the lock. */
export async function removeLease(dir: string): Promise<void> {
  await stopMongod(mongodPaths(dir).dbpath, 0);
  rmSync(dir, { recursive: true, force: true });
}

async function quiet(record: LeaseRecord, dir: string): Promise<boolean> {
  if (mongodPid(mongodPaths(dir).dbpath) !== undefined) return false;
  for (const port of Object.values(record.ports))
    if (await accepting(port)) return false;
  return true;
}

async function removable(
  observed: Observed,
  policy: SweepPolicy,
): Promise<boolean> {
  const { entry, state } = observed;
  if (state.kind === "stale") return true;
  if (state.kind === "claiming") return policy.leftovers;
  if (state.kind !== "live" || policy.idleBefore === undefined) return false;
  if (entry.parsed?.kind !== "current") return false;
  if (statSync(entry.dir).mtimeMs >= policy.idleBefore) return false;
  return quiet(entry.parsed.record, entry.dir);
}

/** Removes the leases `policy` allows and returns the others, observed. Call under the lock. */
export async function sweep(
  home: string,
  policy: SweepPolicy,
): Promise<Observed[]> {
  const kept: Observed[] = [];
  for (const entry of readEntries(home)) {
    const observed = await observe(entry);
    if (await removable(observed, policy)) await removeLease(entry.dir);
    else kept.push(observed);
  }
  return kept;
}

function writeRecord(dir: string, record: LeaseRecord): void {
  const file = join(dir, RECORD_FILE);
  const partial = `${file}.${process.pid}.tmp`;
  writeFileSync(partial, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(partial, file);
}

/** The error for a lease directory whose record this version cannot read. */
export function foreignRecord(dir: string): Error {
  return new Error(
    `antelopejs-lease: ${join(dir, RECORD_FILE)} was written by another antelopejs-lease version; run that version, or remove the directory once nothing uses it`,
  );
}

function orphanedOwn(observed: Observed, worktree: Worktree): Error {
  if (observed.entry.parsed?.kind !== "current")
    return foreignRecord(observed.entry.dir);
  const { ports } = observed.entry.parsed.record;
  const pids = [ports.api, ports.web].flatMap(listenerPids);
  return new Error(
    `antelopejs-lease: the lease of ${worktree.path} belongs to an earlier checkout at this path, whose servers still listen on api port ${ports.api} or web port ${ports.web}${pids.length ? ` (pids ${pids.join(", ")})` : ""}; stop them, then rerun`,
  );
}

function reuse(
  observed: Observed,
  worktree: Worktree,
  mongo: MongoMode,
): Lease {
  if (
    observed.state.kind !== "live" ||
    observed.entry.parsed?.kind !== "current"
  )
    throw orphanedOwn(observed, worktree);
  const { dir } = observed.entry;
  const current = observed.entry.parsed.record;
  const record = current.mongo === mongo ? current : { ...current, mongo };
  if (record !== current) writeRecord(dir, record);
  const now = new Date();
  utimesSync(dir, now, now);
  return { record, dir };
}

/**
 * The lease of `worktree`, created on first use: the same record, ports and directory on every
 * later call from the same checkout. Sweeps stale leases on the way.
 */
export function openLease(
  home: string,
  worktree: Worktree,
  mongo: MongoMode,
): Promise<Lease> {
  return withRegistryLock(async () => {
    const kept = await sweep(home, { leftovers: false });
    const own = kept.find(
      (observed) =>
        observed.entry.id === worktree.id && observed.state.kind !== "claiming",
    );
    if (own !== undefined) return reuse(own, worktree, mongo);
    const taken = new Set(
      kept.flatMap((observed) => reservedBy(observed.entry)),
    );
    const ports = await chooseBlock(worktree.id, taken, bindable);
    const dir = join(home, worktree.id);
    for (const sub of ["mongo", "logs", "tmp"])
      mkdirSync(join(dir, sub), { recursive: true });
    const record: LeaseRecord = {
      version: 1,
      id: worktree.id,
      worktree: worktree.path,
      gitInode: worktree.git.inode,
      gitBirth: worktree.git.birth,
      ports,
      createdAt: new Date().toISOString(),
      mongo,
    };
    writeRecord(dir, record);
    return { record, dir };
  });
}
