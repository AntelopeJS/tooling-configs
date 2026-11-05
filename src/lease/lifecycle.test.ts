import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import type { Server } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import {
  externalEnv,
  gitInit,
  lease,
  leasedEnv,
  scratch,
  statusRows,
} from "./helpers/cli.ts";
import { claimPort, closeServer } from "./ports.ts";

const ROLE_VARS = [
  "ANTELOPEJS_LEASE",
  "DMS_BACK_PORT",
  "DMS_FRONT_PORT",
  "DMS_SMTP_PORT",
  "DMS_INSPECT_PORT",
  "MONGO_URL",
];

async function listen(t: test.TestContext, port: number): Promise<Server> {
  const server = await claimPort(port);
  if (server === undefined) throw new Error(`port ${port} is taken`);
  t.after(() => closeServer(server));
  return server;
}

test("a second run in the same worktree, from a subdirectory, hands out the same lease and ports (fails when a run picks a new block instead of reusing its record, or keys the lease on the cwd)", async (t) => {
  const root = scratch(t);
  const worktree = gitInit(join(root, "w"));
  const env = externalEnv(join(root, ".home"));
  const first = await leasedEnv(worktree, env);
  mkdirSync(join(worktree, "packages", "app"), { recursive: true });
  const second = await leasedEnv(join(worktree, "packages", "app"), env);
  for (const name of ROLE_VARS) assert.equal(second[name], first[name], name);
});

test("status sweeps the lease of a deleted worktree and its directory (fails when status lists leases without checking their worktree)", async (t) => {
  const root = scratch(t);
  const worktree = gitInit(join(root, "w"));
  const env = externalEnv(join(root, ".home"));
  const printed = await leasedEnv(worktree, env);
  rmSync(worktree, { recursive: true });
  const rows = await statusRows(root, env);
  assert.deepEqual(
    rows.map((row) => row.id),
    [],
  );
  assert.equal(existsSync(String(printed.ANTELOPEJS_LEASE_DIR)), false);
});

test("a worktree recreated at the same path gets a fresh lease without the old data (fails when identity is the path alone)", async (t) => {
  const root = scratch(t);
  const worktree = join(root, "w");
  const env = externalEnv(scratch(t));
  gitInit(worktree);
  const touched = await lease(
    ["run", "--", "sh", "-c", 'touch "$TMPDIR/old-data"'],
    worktree,
    env,
  );
  assert.equal(touched.code, 0, touched.stderr);
  rmSync(worktree, { recursive: true });
  await sleep(50);
  gitInit(worktree);
  const probed = await lease(
    [
      "run",
      "--",
      "sh",
      "-c",
      'test -e "$TMPDIR/old-data" && echo inherited || echo fresh',
    ],
    worktree,
    env,
  );
  assert.equal(probed.stdout.trim(), "fresh");
});

test("a deleted worktree whose api port still listens stays reserved as orphaned, naming the listener, until the port closes (fails when the sweep frees a block whose servers still run)", async (t) => {
  const root = scratch(t);
  const worktree = gitInit(join(root, "w"));
  const env = externalEnv(join(root, ".home"));
  const printed = await leasedEnv(worktree, env);
  const server = await listen(t, Number(printed.DMS_BACK_PORT));
  rmSync(worktree, { recursive: true });
  const [orphan] = await statusRows(root, env);
  assert.equal(orphan?.state, "orphaned:missing");
  if (process.platform === "linux")
    assert.ok(orphan?.pids.includes(process.pid));
  await closeServer(server);
  assert.deepEqual(await statusRows(root, env), []);
});

test("status prints nothing when no lease exists (fails when it prints a bare header)", async (t) => {
  const root = scratch(t);
  const outcome = await lease(["status"], root, externalEnv(join(root, "h")));
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.equal(outcome.stdout, "");
});
