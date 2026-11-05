import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  envFor,
  gitInit,
  lease,
  leasedEnv,
  scratch,
  statusRows,
} from "./helpers/cli.ts";
import { findMongod } from "./mongo.ts";
import { accepting } from "./ports.ts";

const binary = findMongod(process.env);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
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
