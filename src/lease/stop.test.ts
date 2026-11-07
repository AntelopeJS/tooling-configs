import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { assertSignallable } from "./procs.ts";
import {
  externalEnv,
  gitInit,
  lease,
  LEASE_ARGV,
  leasedEnv,
  scratch,
} from "./helpers/cli.ts";
import {
  isLive,
  startDaemon,
  startRun,
  startWaiter,
  TREE,
  WAITER,
} from "./helpers/stop.ts";

function lines(text: string): string[] {
  return text.split("\n").filter(Boolean);
}

test(
  "down --stop ends the process group of a run and a daemonized listener that ignores SIGTERM, printing one line for each (fails when it signals only the run pid, skips listeners in other groups, or never escalates to SIGKILL)",
  { timeout: 60_000 },
  async (t) => {
    const root = scratch(t);
    const worktree = gitInit(join(root, "w"));
    const env = externalEnv(join(root, ".home"));
    const printed = await leasedEnv(worktree, env);
    const api = Number(printed.DMS_BACK_PORT);
    const { started, line } = await startRun(t, worktree, env, TREE);
    const [runPid = 0, kidPid = 0] = line.split(" ").map(Number);
    const daemon = await startDaemon(t, api, true);
    const outcome = await lease(["down", "--stop"], worktree, env);
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.deepEqual(lines(outcome.stdout), [
      `stopped pid ${runPid} (run, process group)`,
      `stopped pid ${daemon} (listening on api port ${api})`,
    ]);
    await started.done;
    assert.deepEqual([runPid, kidPid, daemon].filter(isLive), []);
    assert.equal(existsSync(String(printed.ANTELOPEJS_LEASE_DIR)), false);
  },
);

test(
  "down --stop leaves alone a run and a listener of another worktree's lease and an unrelated process with the run's own command line (fails when it stops every lease's runs, every listener in the port band, or matches processes by command line)",
  { timeout: 30_000 },
  async (t) => {
    const root = scratch(t);
    const env = externalEnv(join(root, ".home"));
    const mine = gitInit(join(root, "mine"));
    const other = gitInit(join(root, "other"));
    await leasedEnv(mine, env);
    const otherLease = await leasedEnv(other, env);
    const own = await startRun(t, mine, env, WAITER);
    const theirs = await startRun(t, other, env, WAITER);
    const theirDaemon = await startDaemon(
      t,
      Number(otherLease.DMS_BACK_PORT),
      false,
    );
    const lookalike = startWaiter(t);
    const outcome = await lease(["down", "--stop"], mine, env);
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.deepEqual(lines(outcome.stdout), [
      `stopped pid ${own.line} (run, process group)`,
    ]);
    await own.started.done;
    assert.deepEqual(
      [theirs.line, theirDaemon, lookalike].map((pid) => isLive(Number(pid))),
      [true, true, true],
    );
    assert.equal(isLive(Number(own.line)), false);
  },
);

test("down --stop never signals a recorded pid whose start time differs or was never recorded (fails when it signals any live recorded pid, which kills the unrelated process a reused pid now names)", async (t) => {
  const root = scratch(t);
  const worktree = gitInit(join(root, "w"));
  const env = externalEnv(join(root, ".home"));
  const printed = await leasedEnv(worktree, env);
  const reused = startWaiter(t);
  const unrecorded = startWaiter(t);
  const runs = join(String(printed.ANTELOPEJS_LEASE_DIR), "runs");
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, String(reused)), "another-boot:1");
  writeFileSync(join(runs, String(unrecorded)), "");
  const outcome = await lease(["down", "--stop"], worktree, env);
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.equal(outcome.stdout, "");
  assert.deepEqual([reused, unrecorded].map(isLive), [true, true]);
});

test("down --stop run from inside a run of its own lease signals neither that run nor its group (fails when the ancestors of the stop are not shielded, which ends the command that called it)", async (t) => {
  const root = scratch(t);
  const worktree = gitInit(join(root, "w"));
  const env = externalEnv(join(root, ".home"));
  const inner = `const r = require("node:child_process").spawnSync(process.execPath, [${JSON.stringify(LEASE_ARGV[1])}, "down", "--stop"], { stdio: "inherit" }); console.log("survived " + r.status);`;
  const outcome = await lease(
    ["run", "--", process.execPath, "-e", inner],
    worktree,
    env,
  );
  assert.equal(outcome.stdout, "survived 0\n");
});

test("down without --stop refuses while a port listens, names --stop, and signals nothing (fails when the refusal keeps sending the caller to manual kills, or down stops listeners unasked)", async (t) => {
  const root = scratch(t);
  const worktree = gitInit(join(root, "w"));
  const env = externalEnv(join(root, ".home"));
  const printed = await leasedEnv(worktree, env);
  const daemon = await startDaemon(t, Number(printed.DMS_BACK_PORT), false);
  const refused = await lease(["down"], worktree, env);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /antelopejs-lease down --stop/u);
  assert.equal(isLive(daemon), true);
  assert.equal(existsSync(String(printed.ANTELOPEJS_LEASE_DIR)), true);
});

test("down --stop prints nothing when nothing runs, with a lease or without one (fails when it reports a stop it did not make)", async (t) => {
  const root = scratch(t);
  const worktree = gitInit(join(root, "w"));
  const env = externalEnv(join(root, ".home"));
  const none = await lease(["down", "--stop"], worktree, env);
  assert.deepEqual([none.code, none.stdout], [0, ""]);
  const printed = await leasedEnv(worktree, env);
  const idle = await lease(["down", "--stop"], worktree, env);
  assert.deepEqual([idle.code, idle.stdout], [0, ""]);
  assert.equal(existsSync(String(printed.ANTELOPEJS_LEASE_DIR)), false);
});

test("every lease signal refuses a pid that is not an integer above 1, so kill(-1), kill(0) or init can never be reached; a guard that only checks for a number lets -1 kill every process of the user", () => {
  for (const pid of [-1, 0, 1, Number.NaN, 1.5, Number(undefined)])
    assert.throws(() => assertSignallable(pid), /refusing to signal pid/);
  assert.doesNotThrow(() => assertSignallable(process.pid));
});
