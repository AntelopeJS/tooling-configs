import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  child,
  isObject,
  num,
  object,
  optNum,
  parseJson,
  str,
  type JsonValue,
} from "../garden/json.ts";

/**
 * The port every antelopejs-lease version listens on, on 127.0.0.1, while it holds the registry lock.
 * Each repository pins its own tooling-configs version, so this port, {@link leaseHome} and the v1
 * record are a protocol between versions: they may be extended, never changed.
 */
export const LOCK_PORT = 20000;

const RECORD_VERSION = 1;

/** The offset of each role's port in its block of ten. Offsets 6 to 9 stay spare for later roles. */
export const PORT_ROLES = {
  api: 0,
  web: 1,
  mongo: 2,
  smtp: 3,
  inspect: 4,
  hmr: 5,
} as const;

export type Role = keyof typeof PORT_ROLES;

export function isRole(value: string): value is Role {
  return Object.hasOwn(PORT_ROLES, value);
}

/** One port per role. */
export type Ports = Readonly<Record<Role, number>>;

/** The first ten hex digits of sha256 over a worktree's real path. */
export type LeaseId = string & { readonly brand: "LeaseId" };

/** `owned`: the lease runs its own mongod. `external`: `DMS_MONGO_URL` named a server the caller runs. */
export type MongoMode = "owned" | "external";

/** The `.git` entry of one checkout. A worktree deleted and recreated at the same path gets a new one. */
export interface GitIdentity {
  readonly inode: number;
  /** Birth time in milliseconds, 0 where the filesystem does not record one. */
  readonly birth: number;
}

/** The `lease.json` record, version 1. Readers ignore fields they do not know. */
export interface LeaseRecord {
  readonly version: 1;
  readonly id: LeaseId;
  readonly worktree: string;
  readonly gitInode: number;
  readonly gitBirth: number;
  readonly ports: Ports;
  readonly createdAt: string;
  readonly mongo: MongoMode;
}

/**
 * What a `lease.json` holds. `foreign` is any file this version cannot read, such as a record of a
 * later version: its ports stay reserved and nothing removes it.
 */
export type ParsedRecord =
  | { readonly kind: "current"; readonly record: LeaseRecord }
  | { readonly kind: "foreign"; readonly reserved: readonly number[] };

/** `ANTELOPEJS_LEASE_HOME`, else `~/.antelopejs/leases`: one registry for every repository of the user. */
export function leaseHome(env: NodeJS.ProcessEnv): string {
  return env.ANTELOPEJS_LEASE_HOME || join(homedir(), ".antelopejs", "leases");
}

export function isLeaseId(value: string): value is LeaseId {
  return /^[0-9a-f]{10}$/u.test(value);
}

/** The lease id of the worktree whose real path is `worktree`. */
export function leaseId(worktree: string): LeaseId {
  const id = createHash("sha256").update(worktree).digest("hex").slice(0, 10);
  if (!isLeaseId(id)) throw new Error(`unexpected digest ${id}`);
  return id;
}

/** Builds a value for every role, so a new role is a compile error until each table names it. */
export function eachRole(value: (role: Role) => number): Ports {
  return {
    api: value("api"),
    web: value("web"),
    mongo: value("mongo"),
    smtp: value("smtp"),
    inspect: value("inspect"),
    hmr: value("hmr"),
  };
}

function isMongoMode(value: string): value is MongoMode {
  return value === "owned" || value === "external";
}

function decodeRecord(value: JsonValue): LeaseRecord | undefined {
  const source = object(value, "lease.json");
  if (num(source, "version") !== RECORD_VERSION) return undefined;
  const id = str(source, "id");
  const mongo = str(source, "mongo");
  if (!isLeaseId(id) || !isMongoMode(mongo)) return undefined;
  const ports = child(source, "ports");
  return {
    version: RECORD_VERSION,
    id,
    worktree: str(source, "worktree"),
    gitInode: num(source, "gitInode"),
    gitBirth: num(source, "gitBirth"),
    ports: eachRole((role) => num(ports, role)),
    createdAt: str(source, "createdAt"),
    mongo,
  };
}

function reservedPorts(value: JsonValue): number[] {
  if (!isObject(value) || !Object.hasOwn(value, "ports")) return [];
  const ports = value.ports;
  if (!isObject(ports)) return [];
  return Object.keys(ports)
    .map((key) => optNum(ports, key))
    .filter((port) => port !== undefined);
}

function tryJson(text: string): JsonValue | undefined {
  try {
    return parseJson(text);
  } catch {
    return undefined;
  }
}

function tryRecord(value: JsonValue): LeaseRecord | undefined {
  try {
    return decodeRecord(value);
  } catch {
    return undefined;
  }
}

/** Reads a `lease.json` leniently: unknown fields are ignored, anything unreadable is `foreign`. */
export function parseRecord(text: string): ParsedRecord {
  const value = tryJson(text);
  if (value === undefined) return { kind: "foreign", reserved: [] };
  const record = tryRecord(value);
  if (record !== undefined) return { kind: "current", record };
  return { kind: "foreign", reserved: reservedPorts(value) };
}
