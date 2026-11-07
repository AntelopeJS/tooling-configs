import { join } from "node:path";

import type { LeaseId, LeaseRecord } from "./protocol.ts";

const LEASE_VARIABLE = "ANTELOPEJS_LEASE";

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
  return `${LEASE_VARIABLE}=${id}`;
}

/**
 * `env` without the lease marker, for a process that outlives the command that started it and
 * belongs to no lease's `down --stop`, such as a lease's mongod started from inside another lease's
 * `run`.
 */
export function unmarked(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { [LEASE_VARIABLE]: _marker, ...rest } = env;
  return rest;
}

export function isServerRole(value: string): value is ServerRole {
  return value === "api" || value === "web";
}

/**
 * The environment `run` hands its command: `parent` without `PORT`, plus the lease's variables.
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
  Object.assign(env, {
    [LEASE_VARIABLE]: record.id,
    ANTELOPEJS_LEASE_DIR: dir,
    DMS_BACK_PORT: String(ports.api),
    DMS_FRONT_PORT: String(ports.web),
    DMS_INSPECT_PORT: String(ports.inspect),
    DMS_SMTP_PORT: String(ports.smtp),
    DMS_CLIENT_BASE_URL: `http://localhost:${ports.web}`,
    MONGO_URL: parent.DMS_MONGO_URL || `mongodb://127.0.0.1:${ports.mongo}`,
    MONGO_DATABASE: `dms_${record.id}`,
    DMS_BACK_LOG: join(dir, "logs", "back.log"),
    DMS_FRONT_LOG: join(dir, "logs", "front.log"),
    TMPDIR: join(dir, "tmp"),
  });
  if (as !== undefined) env.PORT = String(ports[as]);
  return env;
}
