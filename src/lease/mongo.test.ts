import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import {
  endRun,
  envFor,
  externalEnv,
  firstLine,
  gitInit,
  lease,
  leasedEnv,
  scratch,
  startLease,
  statusRows,
} from "./helpers/cli.ts";
import { isLive as alive } from "./helpers/stop.ts";
import { findMongod } from "./mongo.ts";
import { accepting, claimPort, closeServer } from "./ports.ts";
import { windowsProcesses } from "./windows.ts";

const binary = findMongod(process.env);

const noMongod =
  binary === undefined &&
  "no mongod on PATH, in MONGOMS_SYSTEM_BINARY or in ~/.cache/mongodb-binaries";

/** The `ps` field `column` of `pid`; `undefined` once the process table has no entry for it. */
function psField(pid: number, column: "ppid" | "stat"): string | undefined {
  try {
    return execFileSync("ps", ["-o", `${column}=`, "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/** The pid of the process that started `pid`; `undefined` once the process table has no entry for it. */
function parentOf(pid: number): string | undefined {
  if (process.platform !== "win32") return psField(pid, "ppid");
  const entry = windowsProcesses().find((candidate) => candidate.pid === pid);
  return entry === undefined ? undefined : String(entry.ppid);
}

/** Whether the process table still has an entry for `pid`, a zombie included. Windows keeps none for an exited process. */
function inTable(pid: number): boolean {
  return process.platform === "win32"
    ? alive(pid)
    : psField(pid, "stat") !== undefined;
}

test(
  "run starts one mongod per lease and reuses it, and down stops it and deletes the lease (fails when run skips mongod or restarts it on every run, or down leaves it running or its data behind)",
  {
    skip: noMongod,
  },
  async (t) => {
    const root = scratch(t);
    const worktree = gitInit(join(root, "w"));
    const env = envFor(join(root, ".home"));
    const printed = await leasedEnv(worktree, env);
    const port = Number(new URL(String(printed.MONGO_URL)).port);
    const [row] = await statusRows(worktree, env);
    const pid = row?.mongod;
    if (pid === undefined) assert.fail("status shows no mongod for the lease");
    t.after(() => {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    });
    assert.equal(await accepting(port), true);
    await leasedEnv(worktree, env);
    const [again] = await statusRows(worktree, env);
    assert.equal(again?.mongod, pid);
    const outcome = await lease(["down"], worktree, env);
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.equal(alive(pid), false);
    assert.equal(await accepting(port), false);
    assert.equal(existsSync(String(printed.ANTELOPEJS_LEASE_DIR)), false);
  },
);

test(
  "run fails and names the holder when a foreign process took the mongo port of a lease whose mongod does not run (fails when readiness is any socket that accepts, which hands the command a MONGO_URL pointing at a stranger)",
  {
    skip: noMongod,
  },
  async (t) => {
    const root = scratch(t);
    const worktree = gitInit(join(root, "w"));
    const home = join(root, ".home");
    await leasedEnv(worktree, externalEnv(home));
    const [row] = await statusRows(worktree, externalEnv(home));
    const port = row?.ports?.mongo;
    if (port === undefined) assert.fail("status shows no ports for the lease");
    const foreign = await claimPort(port, "127.0.0.1");
    if (foreign === undefined) assert.fail(`port ${port} is already taken`);
    t.after(() => closeServer(foreign));
    const outcome = await lease(["run", "--", "true"], worktree, envFor(home));
    assert.equal(outcome.code, 1);
    assert.match(
      outcome.stderr,
      new RegExp(`mongod did not answer on port ${port}`, "u"),
    );
    if (process.platform !== "darwin")
      assert.match(
        outcome.stderr,
        new RegExp(`held by pid ${process.pid}`, "u"),
      );
  },
);

test(
  "eight runs starting at once in a fresh worktree all succeed on one mongod (fails when a run gives up as soon as its own mongod exits, before the mongod that won the dbpath lock has written its pid)",
  {
    skip: noMongod,
  },
  async (t) => {
    const root = scratch(t);
    const worktree = gitInit(join(root, "w"));
    const env = envFor(join(root, ".home"));
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        lease(["run", "--", "true"], worktree, env),
      ),
    );
    const [row] = await statusRows(worktree, env);
    const pid = row?.mongod;
    t.after(() => {
      if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
    });
    assert.deepEqual(
      outcomes.map((outcome) => outcome.code),
      Array.from({ length: 8 }, () => 0),
      outcomes.map((outcome) => outcome.stderr).join(""),
    );
    assert.notEqual(pid, undefined);
  },
);

test(
  "mongod is never a child of the command run becomes, and down leaves no entry of it in the process table (fails when run spawns mongod itself and then execs the command, which inherits mongod as a child that stays a zombie after down until the command exits)",
  {
    skip: noMongod,
  },
  async (t) => {
    const root = scratch(t);
    const worktree = gitInit(join(root, "w"));
    const env = envFor(join(root, ".home"));
    const command = startLease(
      [
        "run",
        "--",
        process.execPath,
        "-e",
        'console.log("ready"); setInterval(() => {}, 1000)',
      ],
      worktree,
      env,
    );
    t.after(() => endRun(command));
    assert.equal(await firstLine(command), "ready");
    const [row] = await statusRows(worktree, env);
    const pid = row?.mongod;
    if (pid === undefined) assert.fail("status shows no mongod for the lease");
    t.after(() => {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    });
    assert.notEqual(parentOf(pid), String(command.child.pid));
    const outcome = await lease(["down"], worktree, env);
    assert.equal(outcome.code, 0, outcome.stderr);
    const deadline = Date.now() + 5_000;
    while (inTable(pid) && Date.now() < deadline) await sleep(50);
    assert.equal(inTable(pid), false);
  },
);
