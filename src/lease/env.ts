import { join } from "node:path";

import type { LeaseId, LeaseRecord } from "./protocol.ts";

/** The variable whose presence marks a command as running under `antelopejs-lease run`; `down --stop` finds a lease's processes by it. */
export const LEASE_MARKER = "ANTELOPEJS_LEASE";

/** A lease record and the directory that holds its data, logs and tmp. */
export interface Lease {
  readonly record: LeaseRecord;
  readonly dir: string;
}

/** The server that gets `PORT` under `run --as`. */
export type ServerRole = "api" | "web";

/**
 * The `environ` entry that `run` hands its command and every descendant inherits, which marks a
 * process as the work of lease `id`.
 */
export function leaseMarker(id: LeaseId): string {
  return `${LEASE_MARKER}=${id}`;
}

/**
 * `env` without the lease marker, for a process that outlives the command that started it and
 * belongs to no lease's `down --stop`, such as a lease's mongod started from inside another lease's
 * `run`.
 */
export function unmarked(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { [LEASE_MARKER]: _marker, ...rest } = env;
  return rest;
}

export function isServerRole(value: string): value is ServerRole {
  return value === "api" || value === "web";
}

/** The variables `run` exports for a DMS dev stack, besides the `ANTELOPEJS_LEASE*` ones. */
export const DEV_STACK_VARIABLES = [
  "DMS_BACK_PORT",
  "DMS_FRONT_PORT",
  "DMS_INSPECT_PORT",
  "DMS_SMTP_PORT",
  "DMS_CLIENT_BASE_URL",
  "MONGO_URL",
  "MONGO_DATABASE",
  "DMS_BACK_LOG",
  "DMS_FRONT_LOG",
  "TMPDIR",
  "PORT",
] as const;

type DevStackVariable = (typeof DEV_STACK_VARIABLES)[number];

/** The variable that carries the lease's directory; a command is under a lease only when this and `LEASE_MARKER` are both non-empty. */
export const LEASE_DIR = "ANTELOPEJS_LEASE_DIR";

/** The variable that carries the caller's own `TMPDIR` past the lease's override; empty when the caller had none, absent from a lease an older pack opened. */
export const PARENT_TMPDIR = "ANTELOPEJS_LEASE_PARENT_TMPDIR";

/** The lease's own tmp folder, which `run` exports as `TMPDIR`. */
export function leaseTmpDir(dir: string): string {
  return join(dir, "tmp");
}

/**
 * The environment `run` hands its command: `parent` without `PORT`, plus the lease's variables.
 * `PARENT_TMPDIR` keeps the caller's own `TMPDIR`, or the one an outer lease recorded.
 * `PORT` comes back only for `as`, because one shell-wide `PORT` makes the backend and the
 * dashboard bind the same port. `DMS_MONGO_URL` in `parent` replaces the lease's own mongod.
 * `DMS_API_BASE_URL` stays unset. A backend whose config hard-codes its port falls back to a free
 * one and records it in `.antelope/dev.json`, and `ajs dms dev` reads that file only without it.
 */
export function leaseEnv(
  lease: Lease,
  parent: NodeJS.ProcessEnv,
  as?: ServerRole,
): NodeJS.ProcessEnv {
  const { record, dir } = lease;
  const { ports } = record;
  const { PORT: _inherited, ...env } = parent;
  const devStack: Record<Exclude<DevStackVariable, "PORT">, string> = {
    DMS_BACK_PORT: String(ports.api),
    DMS_FRONT_PORT: String(ports.web),
    DMS_INSPECT_PORT: String(ports.inspect),
    DMS_SMTP_PORT: String(ports.smtp),
    DMS_CLIENT_BASE_URL: `http://localhost:${ports.web}`,
    MONGO_URL: parent.DMS_MONGO_URL || `mongodb://127.0.0.1:${ports.mongo}`,
    MONGO_DATABASE: `dms_${record.id}`,
    DMS_BACK_LOG: join(dir, "logs", "back.log"),
    DMS_FRONT_LOG: join(dir, "logs", "front.log"),
    TMPDIR: leaseTmpDir(dir),
  };
  Object.assign(env, devStack, {
    [LEASE_MARKER]: record.id,
    [LEASE_DIR]: dir,
    [PARENT_TMPDIR]: parent[PARENT_TMPDIR] ?? parent.TMPDIR ?? "",
  });
  if (as !== undefined) env.PORT = String(ports[as]);
  return env;
}
