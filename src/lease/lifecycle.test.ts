import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import type { Server } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import {
  endRun,
  externalEnv,
  firstLine,
  gitInit,
  lease,
  leasedEnv,
  scratch,
  startLease,
  statusRows,
} from "./helpers/cli.ts";
import { claimPort, closeServer } from "./ports.ts";

const PRINT_DIR_THEN_WAIT =
  "console.log(process.env.ANTELOPEJS_LEASE_DIR); setInterval(() => {}, 1000)";

const TOUCH_OLD_DATA = `require("node:fs").writeFileSync(require("node:path").join(process.env.TMPDIR, "old-data"), "")`;

const PROBE_OLD_DATA = `console.log(require("node:fs").existsSync(require("node:path").join(process.env.TMPDIR, "old-data")) ? "inherited" : "fresh")`;

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
    ["run", "--", process.execPath, "-e", TOUCH_OLD_DATA],
    worktree,
    env,
  );
  assert.equal(touched.code, 0, touched.stderr);
  rmSync(worktree, { recursive: true });
  await sleep(50);
  gitInit(worktree);
  const probed = await lease(
    ["run", "--", process.execPath, "-e", PROBE_OLD_DATA],
    worktree,
    env,
  );
  assert.equal(probed.stdout.trim(), "fresh");
});

/** Denies everyone reading the worktree: mode 000 on its parent on POSIX; on Windows, where everyone may pass through a folder they cannot read and chmod only sets the read-only flag, a deny entry for Everyone on the worktree, inherited by its `.git`. */
function denyReading(path: string): void {
  if (process.platform === "win32")
    execFileSync("icacls", [path, "/deny", "*S-1-1-0:(OI)(CI)(F)"]);
  else chmodSync(path, 0o000);
}

/** Whether a separate Node process can still list `path`, which the permission check, not this test's own reads, decides. */
function canList(path: string): boolean {
  return (
    spawnSync(process.execPath, [
      "-e",
      "require('node:fs').readdirSync(process.argv[1])",
      path,
    ]).status === 0
  );
}

function allowReading(path: string): void {
  if (process.platform === "win32")
    execFileSync("icacls", [path, "/remove:d", "*S-1-1-0"]);
  else chmodSync(path, 0o755);
}

test("status keeps the lease of a worktree it cannot read and lists it as unreadable until it can (fails when a permission error reads as a deleted worktree and the sweep deletes a live checkout's lease)", async (t) => {
  const root = scratch(t);
  const worktree = gitInit(join(root, "parent", "w"));
  const env = externalEnv(join(root, ".home"));
  const printed = await leasedEnv(worktree, env);
  const locked = process.platform === "win32" ? worktree : join(root, "parent");
  denyReading(locked);
  let hidden;
  try {
    if (canList(worktree)) {
      t.skip(
        "this process reads past any permission, as root on POSIX or with SeBackupPrivilege on an elevated Windows runner, so no folder can be made unreadable to it",
      );
      return;
    }
    hidden = await statusRows(root, env);
  } finally {
    allowReading(locked);
  }
  assert.deepEqual(
    hidden.map((row) => row.state),
    [process.platform === "win32" ? "unreadable:EPERM" : "unreadable:EACCES"],
  );
  assert.equal(existsSync(String(printed.ANTELOPEJS_LEASE_DIR)), true);
  const [again] = await statusRows(root, env);
  assert.equal(again?.state, "live");
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

test("down refuses while the api port listens and tears the lease down once forced (fails when down deletes data under running servers)", async (t) => {
  const root = scratch(t);
  const worktree = gitInit(join(root, "w"));
  const env = externalEnv(join(root, ".home"));
  const printed = await leasedEnv(worktree, env);
  const dir = String(printed.ANTELOPEJS_LEASE_DIR);
  await listen(t, Number(printed.DMS_BACK_PORT));
  const refused = await lease(["down"], worktree, env);
  assert.equal(refused.code, 1);
  assert.equal(existsSync(dir), true);
  const forced = await lease(["down", "--force"], worktree, env);
  assert.equal(forced.code, 0, forced.stderr);
  assert.equal(existsSync(dir), false);
});

function backdate(dir: string, days: number): void {
  const then = new Date(Date.now() - days * 86_400_000);
  utimesSync(dir, then, then);
}

test("gc removes a crash leftover at once and an idle lease only past --idle (fails when gc skips leftovers or ignores the idle age)", async (t) => {
  const root = scratch(t);
  const home = join(root, ".home");
  const worktree = gitInit(join(root, "w"));
  const env = externalEnv(home);
  const dir = String((await leasedEnv(worktree, env)).ANTELOPEJS_LEASE_DIR);
  const leftover = join(home, "0123456789");
  mkdirSync(leftover);
  assert.equal((await lease(["gc", "--idle", "1"], root, env)).code, 0);
  assert.equal(existsSync(leftover), false);
  assert.equal(existsSync(dir), true);
  backdate(dir, 2);
  assert.equal((await lease(["gc", "--idle", "1"], root, env)).code, 0);
  assert.equal(existsSync(dir), false);
});

test("gc refuses an --idle below one day (fails when --idle 0 is accepted, which removes the lease of a run that is still starting)", async (t) => {
  const root = scratch(t);
  const outcome = await lease(["gc", "--idle", "0"], root, externalEnv(root));
  assert.equal(outcome.code, 1);
  assert.match(outcome.stderr, /--idle takes 1 or more days, not 0/u);
});

test("gc keeps the lease of a run that is still running, however old its directory looks, and removes it once the run ends (fails when gc judges idleness by directory age and ports alone, which deletes the TMPDIR of a running command)", async (t) => {
  const root = scratch(t);
  const worktree = gitInit(join(root, "w"));
  const env = externalEnv(join(root, ".home"));
  const running = startLease(
    ["run", "--", process.execPath, "-e", PRINT_DIR_THEN_WAIT],
    worktree,
    env,
  );
  t.after(() => endRun(running));
  const dir = await firstLine(running);
  backdate(dir, 30);
  assert.equal((await lease(["gc", "--idle", "1"], root, env)).code, 0);
  assert.equal(existsSync(join(dir, "tmp")), true);
  endRun(running);
  await running.done;
  assert.equal((await lease(["gc", "--idle", "1"], root, env)).code, 0);
  assert.equal(existsSync(dir), false);
});

test("status prints nothing when no lease exists (fails when it prints a bare header)", async (t) => {
  const root = scratch(t);
  const outcome = await lease(["status"], root, externalEnv(join(root, "h")));
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.equal(outcome.stdout, "");
});
