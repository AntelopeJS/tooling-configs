import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
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
  feature,
  newRun,
  PUBLISH_DOORS,
  runEntries,
  verify,
  verifyRepo,
} from "./helpers/verify-repo.ts";

const SKILL = ".agents/skills/verify-module";

const CONFIG = `import { exitIs } from ${JSON.stringify(CHECKS)};
const install = (context) =>
  context.command("install", process.execPath, ["-e", "const fs = require('fs'); fs.mkdirSync('node_modules/dep', { recursive: true }); fs.writeFileSync('node_modules/dep/index.js', ''); fs.writeFileSync(process.env.HOME + '/.npmrc', '')"]);
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
        await context.command("hang", process.execPath, ["-e", "require('fs').writeFileSync('started', String(process.pid)); setInterval(() => {}, 1000)"]);
      },
    },
  },
};
`;

function lifecycleRepo(t: TestContext) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-lifecycle-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    [`${SKILL}/verify.config.ts`]: CONFIG,
    [`${SKILL}/features/smoke.md`]: feature([], ["passes", "fails"]),
    [`${SKILL}/features/stuck.md`]: feature(["src/**"], ["hangs"]),
  });
  return { root, tmp };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "condition held within 30 s");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("a journey that passes or fails deletes its install and HOME and leaves only the evidence and run.json", (t) => {
  const { root, tmp } = lifecycleRepo(t);
  const run = newRun(root, tmp);
  const result = verify(root, tmp, ["journey", run, "smoke"]);
  assert.match(result.stdout, /^PASS smoke\/passes\nFAIL smoke\/fails\n/);
  assert.deepEqual(runEntries(run), ["evidence", "run.json"]);
  assert.equal(
    read(run, "evidence/smoke/fails/01-install/exit-code.txt"),
    "0\n",
  );
});

test("an interrupted journey stops its commands, deletes its install and HOME, and exits with the signal's code", async (t) => {
  const { root, tmp } = lifecycleRepo(t);
  const run = newRun(root, tmp);
  const started = join(run, "work/stuck/hangs/started");
  const child = spawn(
    process.execPath,
    [join(PACKAGE_ROOT, "src/bin/verify.ts"), "journey", run, "stuck"],
    { cwd: root, env: { ...process.env, CI: "1", TMPDIR: tmp } },
  );
  const exited = new Promise<number | null>((resolve) =>
    child.on("exit", (code) => resolve(code)),
  );
  await until(() => existsSync(started));
  const hang = Number(read(run, "work/stuck/hangs/started"));
  child.kill("SIGTERM");
  assert.equal(await exited, 143);
  await until(() => !alive(hang));
  assert.deepEqual(runEntries(run), ["evidence", "run.json"]);
});

test("new deletes runs untouched for 7 days, of any repository, and keeps recent runs and runs with a live process", async (t) => {
  const { root, tmp } = lifecycleRepo(t);
  const stale = newRun(root, tmp);
  const recent = newRun(root, tmp);
  const busy = newRun(root, tmp);
  const other = join(
    tmp,
    "antelopejs-verify/other-repo/20200101T000000-abcdef",
  );
  put(other, "work/app/node_modules/dep/index.js", "");
  const sleeper = spawn(process.execPath, [
    "-e",
    "setInterval(() => {}, 1000)",
  ]);
  t.after(() => sleeper.kill("SIGKILL"));
  const state = JSON.parse(read(busy, "run.json"));
  writeFileSync(
    join(busy, "run.json"),
    JSON.stringify({
      ...state,
      processes: [{ name: "app", pid: sleeper.pid }],
    }),
  );
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  for (const file of [join(stale, "run.json"), join(busy, "run.json"), other])
    utimesSync(file, old, old);
  newRun(root, tmp);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(other), false);
  assert.equal(existsSync(recent), true);
  assert.equal(existsSync(busy), true);
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
