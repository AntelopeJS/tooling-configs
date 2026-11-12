import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { PACKAGE_ROOT, put, read } from "../guardrails/helpers/test-repo.ts";
import {
  CHECKS,
  evidence,
  feature,
  newRun,
  PUBLISH_DOORS,
  runEntries,
  verify,
  verifyRepo,
} from "./helpers/verify-repo.ts";

const SKILL = ".agents/skills/verify-module";

/** Starts a writer that keeps recreating HOME, records the writer's PID in `started`, and never exits. */
const HANG = `const writer = require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(
  'const fs = require("fs"); setInterval(() => { fs.mkdirSync(process.env.HOME, { recursive: true }); fs.writeFileSync(process.env.HOME + "/late", ""); }, 20)',
)}], { stdio: "ignore" });
require("fs").writeFileSync("started", String(writer.pid));
setInterval(() => {}, 1000);`;

/** Starts a child that holds the command's output open for a minute. */
const SLOW = `require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "inherit" }); setTimeout(() => {}, 60000);`;

const WINDOWS = process.platform === "win32";

/** Folders Windows cannot delete are those a live process holds as its working folder, where POSIX denies the delete by the parent's mode. */
const NO_SIGNALS =
  WINDOWS &&
  "Windows has no SIGTERM or SIGQUIT to send: kill() ends the journey process at once with no exit code to forward";

function lock(pidFile: string): string {
  return WINDOWS
    ? `const child = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); child.unref(); fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))`
    : "fs.chmodSync('..', 0o555)";
}

function config(pidFile: string): string {
  return `import { exitIs } from ${JSON.stringify(CHECKS)};
const install = (context) =>
  context.command("install", process.execPath, ["-e", "const fs = require('fs'); fs.mkdirSync('node_modules/dep', { recursive: true }); fs.writeFileSync('node_modules/dep/index.js', ''); fs.chmodSync('node_modules/dep', 0o555); fs.writeFileSync(process.env.HOME + '/.npmrc', '')"]);
export default {
  doors: ${PUBLISH_DOORS},
  journeys: {
    passes: {
      title: "installs and passes",
      entryPoint: "node",
      async run(context) {
        const result = await install(context);
        context.expect(result.folder, [exitIs(result, 0)]);
      },
    },
    fails: {
      title: "installs and fails",
      entryPoint: "node",
      async run(context) {
        const result = await install(context);
        context.expect(result.folder, [exitIs(result, 1)]);
      },
    },
    hangs: {
      title: "installs and hangs",
      entryPoint: "node",
      async run(context) {
        await install(context);
        await context.command("hang", process.execPath, ["-e", ${JSON.stringify(HANG)}]);
      },
    },
    slow: {
      title: "runs a command past its timeout",
      entryPoint: "node",
      async run(context) {
        const result = await context.command("sleep", process.execPath, ["-e", ${JSON.stringify(SLOW)}], { timeoutMs: 500 });
        context.expect(result.folder, [exitIs(result, 0)]);
      },
    },
    locked: {
      title: "installs a folder it cannot delete",
      entryPoint: "node",
      async run(context) {
        const result = await context.command("install", process.execPath, ["-e", ${JSON.stringify(`const fs = require('fs'); fs.mkdirSync('node_modules/locked', { recursive: true }); fs.writeFileSync('node_modules/locked/index.js', ''); ${lock(pidFile)}`)}]);
        context.expect(result.folder, [exitIs(result, 0)]);
      },
    },
  },
};
`;
}

function lifecycleRepo(t: TestContext) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-lifecycle-"));
  const leaked: number[] = [];
  t.after(() => {
    for (const pid of leaked) stop(pid);
    if (!WINDOWS) execFileSync("chmod", ["-R", "u+w", tmp]);
    rmSync(tmp, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  });
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    [`${SKILL}/verify.config.ts`]: config(join(tmp, "locked.pid")),
    [`${SKILL}/features/smoke.md`]: feature([], ["passes", "fails"]),
    [`${SKILL}/features/stuck.md`]: feature(["src/**"], ["hangs"]),
    [`${SKILL}/features/slow.md`]: feature(["src/**"], ["slow"]),
    [`${SKILL}/features/locked.md`]: feature(["src/**"], ["locked"]),
  });
  return { root, tmp, leaked };
}

function stop(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Records a live process in the run's run.json, as another journey's app would be, and returns its PID. */
function recordSleeper(t: TestContext, run: string): number {
  const sleeper = spawn(process.execPath, [
    "-e",
    "setInterval(() => {}, 1000)",
  ]);
  t.after(() => sleeper.kill("SIGKILL"));
  const state = JSON.parse(read(run, "run.json"));
  writeFileSync(
    join(run, "run.json"),
    JSON.stringify({
      ...state,
      processes: [{ name: "app", pid: sleeper.pid }],
    }),
  );
  return Number(sleeper.pid);
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "condition held within 30 s");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("a journey that passes or fails deletes its install, read-only folders included, and its HOME, leaving only the evidence and run.json", (t) => {
  const { root, tmp } = lifecycleRepo(t);
  const run = newRun(root, tmp);
  const result = verify(root, tmp, ["journey", run, "smoke"]);
  assert.match(
    result.stdout,
    /^PASS smoke\/passes \(\d+\.\d s\)\nFAIL smoke\/fails \(\d+\.\d s\)\n/,
  );
  assert.deepEqual(runEntries(run), ["evidence", "run.json"]);
  assert.equal(
    read(run, "evidence/smoke/fails/01-install/exit-code.txt"),
    "0\n",
  );
});

for (const [signal, code] of [
  ["SIGTERM", 143],
  ["SIGQUIT", 131],
] as const)
  test(
    `a journey interrupted by ${signal} stops its commands and what they started, spares another journey's processes, deletes its install and HOME even when run.json cannot be written, and exits ${code}`,
    { skip: NO_SIGNALS },
    async (t) => {
      const { root, tmp } = lifecycleRepo(t);
      const run = newRun(root, tmp);
      const other = recordSleeper(t, run);
      const started = join(run, "work/stuck/hangs/started");
      const child = spawn(
        process.execPath,
        [join(PACKAGE_ROOT, "src/bin/verify.ts"), "journey", run, "stuck"],
        { cwd: root, env: { ...process.env, CI: "1", TMPDIR: tmp } },
      );
      const exited = new Promise<number | null>((resolve) =>
        child.on("exit", (exit) => resolve(exit)),
      );
      await until(() => existsSync(started));
      const hang = Number(read(run, "work/stuck/hangs/started"));
      t.after(() => stop(hang));
      chmodSync(join(run, "run.json"), 0o444);
      child.kill(signal);
      assert.equal(await exited, code);
      await until(() => !alive(hang));
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(runEntries(run), ["evidence", "run.json"]);
      assert.equal(alive(other), true);
    },
  );

test("a command that outlives its timeout is killed with what it started, and the journey ends", (t) => {
  const { root, tmp } = lifecycleRepo(t);
  const run = newRun(root, tmp);
  const began = Date.now();
  const result = verify(root, tmp, ["journey", run, "slow"]);
  assert.match(result.stdout, /^FAIL slow\/slow \(\d+\.\d s\)\n/);
  assert.ok(Date.now() - began < 20_000, "the journey ended near the timeout");
  assert.deepEqual(runEntries(run), ["evidence", "run.json"]);
});

test("a journey whose install cannot be deleted still records its result and names the folder it left", (t) => {
  const { root, tmp, leaked } = lifecycleRepo(t);
  const run = newRun(root, tmp);
  const result = verify(root, tmp, ["journey", run, "locked"]);
  if (WINDOWS) leaked.push(Number(read(tmp, "locked.pid")));
  assert.match(result.stdout, /^PASS locked\/locked \(\d+\.\d s\)\n$/);
  assert.match(result.stderr, /could not delete .*work[\\/]locked[\\/]locked/);
  assert.equal(evidence(run, "locked/feature.json")[0].status, "PASS");
});

test("new skips a stale run it cannot delete, says so, and still creates its run", (t) => {
  const { root, tmp, leaked } = lifecycleRepo(t);
  const stale = join(
    tmp,
    "antelopejs-verify/other-repo/20200101T000000-abcdef",
  );
  put(stale, "work/node_modules/dep/index.js", "");
  if (WINDOWS) {
    const holder = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        cwd: join(stale, "work"),
        stdio: "ignore",
      },
    );
    leaked.push(Number(holder.pid));
  } else chmodSync(join(stale, ".."), 0o555);
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(stale, old, old);
  const created = verify(root, tmp, ["new"]);
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stderr, /could not prune .*20200101T000000-abcdef/);
  assert.equal(existsSync(created.stdout.trim()), true);
});

test("new deletes runs untouched for 7 days, of any repository, and keeps recent runs and runs with a live process, one a journey command recorded in its own file included; a prune that reads run.json alone deletes that run", async (t) => {
  const { root, tmp } = lifecycleRepo(t);
  const stale = newRun(root, tmp);
  const recent = newRun(root, tmp);
  const busy = newRun(root, tmp);
  const recording = newRun(root, tmp);
  const sleeper = spawn(process.execPath, [
    "-e",
    "setInterval(() => {}, 1000)",
  ]);
  t.after(() => sleeper.kill("SIGKILL"));
  writeFileSync(
    join(recording, "processes-4242-0a1b.json"),
    JSON.stringify([{ name: "app (demo)", pid: sleeper.pid }]),
  );
  const other = join(
    tmp,
    "antelopejs-verify/other-repo/20200101T000000-abcdef",
  );
  put(other, "work/app/node_modules/dep/index.js", "");
  recordSleeper(t, busy);
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  for (const file of [
    join(stale, "run.json"),
    join(busy, "run.json"),
    join(recording, "run.json"),
    other,
  ])
    utimesSync(file, old, old);
  newRun(root, tmp);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(other), false);
  assert.equal(existsSync(recent), true);
  assert.equal(existsSync(busy), true);
  assert.equal(existsSync(recording), true);
});

test("a command on an old run marks it active, so the next new keeps it", (t) => {
  const { root, tmp } = lifecycleRepo(t);
  const run = newRun(root, tmp);
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(join(run, "run.json"), old, old);
  assert.match(
    verify(root, tmp, ["doctor", run]).stdout,
    /HEAD unchanged since new/,
  );
  newRun(root, tmp);
  assert.equal(existsSync(run), true);
});

test("doctor and clean see a process another journey command recorded in its own file: doctor names it, clean kills it and deletes the file; a reader of run.json alone misses it and leaves it running", async (t) => {
  const { root, tmp } = lifecycleRepo(t);
  const run = newRun(root, tmp);
  const sleeper = spawn(process.execPath, [
    "-e",
    "setInterval(() => {}, 1000)",
  ]);
  t.after(() => sleeper.kill("SIGKILL"));
  writeFileSync(
    join(run, "processes-4242-0a1b.json"),
    JSON.stringify([{ name: "app (demo)", pid: sleeper.pid }]),
  );
  assert.match(
    verify(root, tmp, ["doctor", run]).stdout,
    new RegExp(`FAIL no leftover process app \\(demo\\): pid ${sleeper.pid}`),
  );
  assert.equal(verify(root, tmp, ["clean", run]).status, 0);
  await until(() => !alive(Number(sleeper.pid)));
  assert.deepEqual(runEntries(run), ["evidence", "run.json"]);
});
