import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { assertSignallable } from "./procs.ts";
import {
  externalEnv,
  firstLine,
  gitInit,
  lease,
  LEASE_ARGV,
  leasedEnv,
  scratch,
  startCaptured,
} from "./helpers/cli.ts";
import {
  isLive,
  reap,
  startDaemon,
  startRun,
  startWaiter,
  stoppedPids,
  TREE,
  WAITER,
} from "./helpers/stop.ts";

const IDLE = "setInterval(() => {}, 1000)";

const STOP_SUPPORTED =
  process.platform === "linux" || process.platform === "win32";

const STOP_UNSUPPORTED =
  !STOP_SUPPORTED &&
  "down --stop reads each process's environment, which only Linux and Windows let it: it refuses elsewhere";

/** Runs the command in its arguments as a child and blocks its own event loop for a minute, so it never collects the child's exit. */
const UNREAPING_PARENT = `require("node:child_process").spawn(process.argv[1], process.argv.slice(2), { stdio: "inherit" });
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);`;

/** Runs the command in its arguments as a child that leads no process group, waits for it, then exits. */
const WAITING_PARENT = `require("node:child_process").spawnSync(process.argv[1], process.argv.slice(2), { stdio: "inherit" });`;

/** Starts an idler that outlives this process, prints its pid, and exits. */
const LEAVE_CHILD = `const kid = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(IDLE)}], { detached: true, stdio: "ignore" });
kid.unref();
console.log(kid.pid);`;

test(
  "down --stop refuses with one line naming Linux and Windows before it touches a lease, and still does nothing without one (fails when it runs on a platform that cannot read a process's environment, which stops nothing and deletes the lease's data under running servers, or when it refuses where there is nothing to stop)",
  { skip: STOP_SUPPORTED && "this platform supports down --stop" },
  async (t) => {
    const root = scratch(t);
    const worktree = gitInit(join(root, "w"));
    const env = externalEnv(join(root, ".home"));
    const none = await lease(["down", "--stop"], worktree, env);
    assert.deepEqual([none.code, none.stdout, none.stderr], [0, "", ""]);
    const printed = await leasedEnv(worktree, env);
    const refused = await lease(["down", "--stop"], worktree, env);
    assert.deepEqual([refused.code, refused.stdout], [1, ""]);
    assert.match(
      refused.stderr,
      /^antelopejs-lease: down --stop reads the environment of each process and runs on Linux and Windows only; .*\n$/u,
    );
    assert.equal(existsSync(String(printed.ANTELOPEJS_LEASE_DIR)), true);
  },
);

function pidsOf(line: string): number[] {
  return line.split(" ").map(Number);
}

test(
  "down --stop ends a run, its child and a daemonized listener of the lease that ignores SIGTERM, printing one line for each (fails when it signals only the run pid, misses processes that left the run's group, or never escalates to SIGKILL)",
  { timeout: 60_000, skip: STOP_UNSUPPORTED },
  async (t) => {
    const root = scratch(t);
    const worktree = gitInit(join(root, "w"));
    const env = externalEnv(join(root, ".home"));
    const printed = await leasedEnv(worktree, env);
    const api = Number(printed.DMS_BACK_PORT);
    const { started, line } = await startRun(t, worktree, env, TREE);
    const daemon = await startDaemon(
      t,
      api,
      true,
      String(printed.ANTELOPEJS_LEASE),
    );
    const outcome = await lease(["down", "--stop"], worktree, env);
    assert.equal(outcome.code, 0, outcome.stderr);
    const expected = [...pidsOf(line), daemon].toSorted((a, b) => a - b);
    assert.deepEqual(stoppedPids(outcome.stdout), expected);
    assert.equal(outcome.stdout.split("\n").filter(Boolean).length, 3);
    await started.done;
    assert.deepEqual(expected.filter(isLive), []);
    assert.equal(existsSync(String(printed.ANTELOPEJS_LEASE_DIR)), false);
  },
);

test(
  "down --stop leaves alone a run and a listener of another worktree's lease and an unrelated process with the run's own command line (fails when it stops every lease's runs, every listener in the port band, or matches processes by command line)",
  { timeout: 30_000, skip: STOP_UNSUPPORTED },
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
      String(otherLease.ANTELOPEJS_LEASE),
    );
    const lookalike = startWaiter(t);
    const outcome = await lease(["down", "--stop"], mine, env);
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.deepEqual(stoppedPids(outcome.stdout), [Number(own.line)]);
    await own.started.done;
    assert.deepEqual(
      [theirs.line, theirDaemon, lookalike].map((pid) => isLive(Number(pid))),
      [true, true, true],
    );
    assert.equal(isLive(Number(own.line)), false);
  },
);

test(
  "down --stop leaves alone a listener on the lease's api port that another registry's lease or a process without the marker holds, and refuses naming it (fails when it signals whatever listens on a lease port, as two registries handing out one port made it kill another test's server in CI)",
  { timeout: 30_000, skip: STOP_UNSUPPORTED },
  async (t) => {
    const root = scratch(t);
    const worktree = gitInit(join(root, "w"));
    const env = externalEnv(join(root, ".home"));
    const printed = await leasedEnv(worktree, env);
    const api = Number(printed.DMS_BACK_PORT);
    const stranger = await startDaemon(t, api, false, "0000000000");
    const outcome = await lease(["down", "--stop"], worktree, env);
    assert.equal(outcome.code, 1);
    assert.equal(outcome.stdout, "");
    assert.match(
      outcome.stderr,
      new RegExp(
        `port ${api} .*after --stop, held by pid ${stranger} without ANTELOPEJS_LEASE=${String(printed.ANTELOPEJS_LEASE)}`,
        "u",
      ),
    );
    assert.equal(isLive(stranger), true);
    assert.equal(existsSync(String(printed.ANTELOPEJS_LEASE_DIR)), true);
  },
);

test(
  "down --stop stops the child of a run whose leader already exited (fails when it finds a run's processes through the run's own pid or group leader, which is gone)",
  { timeout: 30_000, skip: STOP_UNSUPPORTED },
  async (t) => {
    const root = scratch(t);
    const worktree = gitInit(join(root, "w"));
    const env = externalEnv(join(root, ".home"));
    const printed = await leasedEnv(worktree, env);
    const started = startCaptured(
      LEASE_ARGV[0] ?? "",
      [
        ...LEASE_ARGV.slice(1),
        "run",
        "--",
        process.execPath,
        "-e",
        LEAVE_CHILD,
      ],
      { cwd: worktree, env, detached: true },
    );
    const kid = Number(await firstLine(started));
    reap(t, kid, false);
    await started.done;
    const outcome = await lease(["down", "--stop"], worktree, env);
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.deepEqual(stoppedPids(outcome.stdout), [kid]);
    assert.equal(isLive(kid), false);
    assert.equal(existsSync(String(printed.ANTELOPEJS_LEASE_DIR)), false);
  },
);

test(
  "down --stop counts a run that exited but that its parent never reaped as gone (fails when a zombie counts as alive, as a kill(-pid, 0) group probe does, so down reports it still running after SIGKILL and keeps the lease)",
  { timeout: 30_000, skip: STOP_UNSUPPORTED },
  async (t) => {
    const root = scratch(t);
    const worktree = gitInit(join(root, "w"));
    const env = externalEnv(join(root, ".home"));
    const printed = await leasedEnv(worktree, env);
    const started = startCaptured(
      process.execPath,
      [
        "-e",
        UNREAPING_PARENT,
        ...LEASE_ARGV,
        "run",
        "--",
        process.execPath,
        "-e",
        TREE,
      ],
      { cwd: worktree, env, detached: true },
    );
    reap(t, started.child.pid ?? 0, true);
    const [run = 0, kid = 0] = pidsOf(await firstLine(started));
    reap(t, run, false);
    reap(t, kid, false);
    const outcome = await lease(["down", "--stop"], worktree, env);
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.deepEqual(
      stoppedPids(outcome.stdout),
      [run, kid].toSorted((a, b) => a - b),
    );
    assert.deepEqual([run, kid].filter(isLive), []);
    assert.equal(existsSync(String(printed.ANTELOPEJS_LEASE_DIR)), false);
  },
);

test(
  "down --stop stops the child of a run that does not lead its process group, as a run started from a script does (fails when it signals a non-leading run alone, leaving its child behind)",
  { timeout: 30_000, skip: STOP_UNSUPPORTED },
  async (t) => {
    const root = scratch(t);
    const worktree = gitInit(join(root, "w"));
    const env = externalEnv(join(root, ".home"));
    const printed = await leasedEnv(worktree, env);
    const started = startCaptured(
      process.execPath,
      [
        "-e",
        WAITING_PARENT,
        ...LEASE_ARGV,
        "run",
        "--",
        process.execPath,
        "-e",
        TREE,
      ],
      { cwd: worktree, env, detached: true },
    );
    reap(t, started.child.pid ?? 0, true);
    const [run = 0, kid = 0] = pidsOf(await firstLine(started));
    reap(t, run, false);
    reap(t, kid, false);
    const outcome = await lease(["down", "--stop"], worktree, env);
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.deepEqual(
      stoppedPids(outcome.stdout),
      [run, kid].toSorted((a, b) => a - b),
    );
    await started.done;
    assert.deepEqual([run, kid].filter(isLive), []);
    assert.equal(existsSync(String(printed.ANTELOPEJS_LEASE_DIR)), false);
  },
);

test(
  "down --stop stops a live run that an earlier version recorded without a start time, before it deletes the lease's data (fails when it trusts only the run records, which skip such a run and delete the data under it)",
  { timeout: 30_000, skip: STOP_UNSUPPORTED },
  async (t) => {
    const root = scratch(t);
    const worktree = gitInit(join(root, "w"));
    const env = externalEnv(join(root, ".home"));
    const printed = await leasedEnv(worktree, env);
    const { started, line } = await startRun(t, worktree, env, TREE);
    const [run = 0, kid = 0] = pidsOf(line);
    const dir = String(printed.ANTELOPEJS_LEASE_DIR);
    writeFileSync(join(dir, "runs", String(run)), "");
    const outcome = await lease(["down", "--stop"], worktree, env);
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.deepEqual(
      stoppedPids(outcome.stdout),
      [run, kid].toSorted((a, b) => a - b),
    );
    await started.done;
    assert.deepEqual([run, kid].filter(isLive), []);
    assert.equal(existsSync(dir), false);
  },
);

test(
  "down --stop never signals a recorded pid whose start time differs or was never recorded (fails when it signals any live recorded pid, which kills the unrelated process a reused pid now names)",
  { skip: STOP_UNSUPPORTED },
  async (t) => {
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
  },
);

test(
  "down --stop run from inside a run of its own lease signals neither that run nor its group (fails when the ancestors of the stop are not shielded, which ends the command that called it)",
  { skip: STOP_UNSUPPORTED },
  async (t) => {
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
  },
);

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

test(
  "down --stop prints nothing when nothing runs, with a lease or without one (fails when it reports a stop it did not make)",
  { skip: STOP_UNSUPPORTED },
  async (t) => {
    const root = scratch(t);
    const worktree = gitInit(join(root, "w"));
    const env = externalEnv(join(root, ".home"));
    const none = await lease(["down", "--stop"], worktree, env);
    assert.deepEqual([none.code, none.stdout], [0, ""]);
    const printed = await leasedEnv(worktree, env);
    const idle = await lease(["down", "--stop"], worktree, env);
    assert.deepEqual([idle.code, idle.stdout], [0, ""]);
    assert.equal(existsSync(String(printed.ANTELOPEJS_LEASE_DIR)), false);
  },
);

test("every lease signal refuses a pid that is not an integer above 1, so kill(-1), kill(0) or init can never be reached; a guard that only checks for a number lets -1 kill every process of the user", () => {
  for (const pid of [-1, 0, 1, Number.NaN, 1.5, Number(undefined)])
    assert.throws(() => assertSignallable(pid), /refusing to signal pid/);
  assert.doesNotThrow(() => assertSignallable(process.pid));
});

test(
  "down --stop piped into a reader of the same lease still tears the lease down when that reader is gone (fails when the broken pipe on its output aborts the teardown)",
  { timeout: 60_000, skip: STOP_UNSUPPORTED },
  async (t) => {
    const root = scratch(t);
    const worktree = gitInit(join(root, "w"));
    const env = externalEnv(join(root, ".home"));
    const printed = await leasedEnv(worktree, env);
    await startRun(t, worktree, env, WAITER);
    const down = LEASE_ARGV.map((part) => `'${part}'`).join(" ");
    const outcome = await lease(
      [
        "run",
        "--",
        "bash",
        "-c",
        `${down} down --stop | head -c 0; echo "down=\${PIPESTATUS[0]}"`,
      ],
      worktree,
      env,
    );
    assert.match(outcome.stdout, /down=0/, outcome.stdout + outcome.stderr);
    assert.equal(existsSync(String(printed.ANTELOPEJS_LEASE_DIR)), false);
  },
);
