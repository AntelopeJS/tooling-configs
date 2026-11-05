import assert from "node:assert/strict";
import type { Server } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import {
  envOf,
  externalEnv,
  gitInit,
  scratch,
  startLeasedEnv,
  statusRows,
} from "./helpers/cli.ts";
import { candidateBases, claimPort, closeServer } from "./ports.ts";
import { leaseId } from "./protocol.ts";

const WORKTREES = 16;
const OPENERS = 32;

/** `count` worktree paths under `root` whose leases all start their scan at the same block. */
function collidingPaths(root: string, count: number): string[] {
  const first = (name: string) => candidateBases(leaseId(join(root, name)))[0];
  const target = first("w0");
  const names: string[] = [];
  for (let index = 0; names.length < count; index += 1)
    if (first(`w${index}`) === target) names.push(`w${index}`);
  return names.map((name) => join(root, name));
}

test("32 openers racing over 16 worktrees that hash to one block get disjoint ports and one id per worktree (fails without the registry lock, or with a lease keyed on anything but the worktree)", async (t) => {
  const root = scratch(t);
  const home = join(root, ".home");
  const worktrees = collidingPaths(root, WORKTREES).map(gitInit);
  const env = externalEnv(home);
  const outcomes = await Promise.all(
    Array.from(
      { length: OPENERS },
      (_, index) =>
        startLeasedEnv(worktrees[index % WORKTREES] ?? root, env).done,
    ),
  );
  const seen = new Map<string, Set<string>>();
  outcomes.forEach((outcome, index) => {
    const printed = envOf(outcome);
    const key = worktrees[index % WORKTREES] ?? root;
    const ids = seen.get(key) ?? new Set<string>();
    ids.add(`${printed.ANTELOPEJS_LEASE}:${printed.DMS_BACK_PORT}`);
    seen.set(key, ids);
  });
  for (const [worktree, ids] of seen)
    assert.equal(ids.size, 1, `${worktree} got ${[...ids].join(", ")}`);
  const rows = await statusRows(root, env);
  assert.equal(rows.length, WORKTREES);
  const ports = rows.flatMap((row) => Object.values(row.ports ?? {}));
  assert.equal(new Set(ports).size, ports.length, "a port is leased twice");
});

async function holdLock(): Promise<Server> {
  for (;;) {
    const server = await claimPort(20000, "127.0.0.1");
    if (server !== undefined) return server;
    await sleep(10);
  }
}

test("an opener waits while 127.0.0.1:20000 is held and opens its lease once it is released (fails when the lock is skipped, gives up at once, or moves off port 20000)", async (t) => {
  const root = scratch(t);
  const worktree = gitInit(join(root, "w"));
  const lock = await holdLock();
  const opener = startLeasedEnv(worktree, externalEnv(join(root, ".home")));
  await sleep(1_500);
  const waited = opener.stdout() === "" && opener.child.exitCode === null;
  await closeServer(lock);
  const outcome = await opener.done;
  assert.ok(waited, "the opener ran its command while the lock was held");
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.match(String(envOf(outcome).ANTELOPEJS_LEASE), /^[0-9a-f]{10}$/u);
});
