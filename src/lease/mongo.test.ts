import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import {
  envFor,
  gitInit,
  lease,
  leasedEnv,
  scratch,
  statusRows,
} from "./helpers/cli.ts";
import { findMongod } from "./mongo.ts";
import { accepting, claimPort, closeServer } from "./ports.ts";

const binary = findMongod(process.env);

/** True while `pid` runs. A zombie has exited: it holds no port and no file. */
function alive(pid: number): boolean {
  try {
    const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return !state.trim().startsWith("Z");
  } catch {
    return false;
  }
}

test(
  "run starts one mongod per lease and reuses it, and down stops it and deletes the lease (fails when run skips mongod or restarts it on every run, or down leaves it running or its data behind)",
  {
    skip:
      binary === undefined &&
      "no mongod on PATH, in MONGOMS_SYSTEM_BINARY or in ~/.cache/mongodb-binaries",
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
  "run fails and names the holder when a foreign process took the mongo port of a lease whose mongod stopped (fails when readiness is any socket that accepts, which hands the command a MONGO_URL pointing at a stranger)",
  {
    skip:
      binary === undefined &&
      "no mongod on PATH, in MONGOMS_SYSTEM_BINARY or in ~/.cache/mongodb-binaries",
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
    process.kill(pid, "SIGTERM");
    while (alive(pid)) await sleep(50);
    const foreign = await claimPort(port, "127.0.0.1");
    if (foreign === undefined) assert.fail(`port ${port} did not free up`);
    t.after(() => closeServer(foreign));
    const outcome = await lease(["run", "--", "true"], worktree, env);
    assert.equal(outcome.code, 1);
    assert.match(
      outcome.stderr,
      new RegExp(`mongod did not answer on port ${port}`, "u"),
    );
    if (process.platform === "linux")
      assert.match(
        outcome.stderr,
        new RegExp(`held by pid ${process.pid}`, "u"),
      );
  },
);

test(
  "eight runs starting at once in a fresh worktree all succeed on one mongod (fails when a run gives up as soon as its own mongod exits, before the mongod that won the dbpath lock has written its pid)",
  {
    skip:
      binary === undefined &&
      "no mongod on PATH, in MONGOMS_SYSTEM_BINARY or in ~/.cache/mongodb-binaries",
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
