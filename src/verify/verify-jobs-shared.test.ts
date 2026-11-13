import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

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
import { loadRun } from "./workspace.ts";

const SKILL = ".agents/skills/verify-module";

const WORKSPACE = pathToFileURL(
  join(PACKAGE_ROOT, "src/verify/workspace.ts"),
).href;

const TWO_JOBS = availableParallelism() < 4 && "needs 4 cores for --jobs 2";

const LOCK =
  "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n";

/** A fake `ajs project dev` that answers 200 once it listens and exits on SIGINT. */
const AJS = String.raw`const http = require("node:http");
process.on("SIGINT", () => process.exit(0));
http.createServer((request, response) => response.end("ok")).listen(Number(process.env.PORT), "127.0.0.1");
`;

/** One journey of a pair that meets the other at each barrier point, so the two run at once. */
function journey(id: string, body: string): string {
  return `${JSON.stringify(id)}: {
      title: "${id}",
      entryPoint: "node",
      async run(context) {
${body}
      },
    }`;
}

function config(barrier: string): string {
  const app = `        await meet(context, "loaded");
        const app = await context.dev("ajs project dev", context.work);
        await meet(context, "started");
        const recorded = loadRun(join(context.work, "../../..")).processes.length;
        context.expect(app.folder, [equal("the run records the apps of both journeys", recorded, 2)]);
        await meet(context, "read");
        await context.stop("stop", app);`;
  const prepared = `        const folder = await context.prepared("tree", async (built) => {
          await meet(context, "build");
          const made = await context.command("build", process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], 'built')", join(built, "value.txt")]);
          context.expect(made.folder, [exitIs(made, 0)]);
        });
        context.expect(context.step("read"), [equal("the copy holds the build", readFileSync(join(folder, "value.txt"), "utf8"), "built")]);`;
  const hang = `        const app = await context.dev("ajs project dev", context.work);
        writeFileSync(join(${JSON.stringify(barrier)}, "app-" + app.pid), "");
        await new Promise((resolve) => setTimeout(resolve, 20000));`;
  const deaf = `        process.removeAllListeners("SIGTERM");
        process.on("SIGTERM", () => {});
${hang}`;
  return `import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { equal, exitIs } from ${JSON.stringify(CHECKS)};
import { loadRun } from ${JSON.stringify(WORKSPACE)};
const meet = async (context, point) => {
  const folder = join(${JSON.stringify(barrier)}, point);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, context.work.replace(/[\\\\/:]/g, "_")), "");
  for (let waited = 0; waited < 5000 && readdirSync(folder).length < 2; waited += 20)
    await new Promise((resolve) => setTimeout(resolve, 20));
};
export default {
  doors: ${PUBLISH_DOORS},
  journeys: {
    ${journey("app-a", app)},
    ${journey("app-b", app)},
    ${journey("prepare-a", prepared)},
    ${journey("prepare-b", prepared)},
    ${journey("hang-a", hang)},
    ${journey("hang-b", hang)},
    ${journey("deaf", deaf)},
  },
};
`;
}

const NO_SIGNAL_FORWARDING =
  process.platform === "win32" &&
  "Windows has no SIGTERM to forward: kill() ends the process at once with no exit code 143";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function repo(t: TestContext) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-jobs-shared-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "package.json": '{"name":"demo","type":"module","version":"1.0.0"}\n',
    "pnpm-lock.yaml": LOCK,
    [`${SKILL}/verify.config.ts`]: config(join(tmp, "barrier")),
    [`${SKILL}/features/smoke.md`]: feature([], ["app-a"]),
    [`${SKILL}/features/apps.md`]: feature(["apps/**"], ["app-b"]),
    [`${SKILL}/features/left.md`]: feature(["left/**"], ["prepare-a"]),
    [`${SKILL}/features/right.md`]: feature(["right/**"], ["prepare-b"]),
    [`${SKILL}/features/hang.md`]: feature(["hang/**"], ["hang-a"]),
    [`${SKILL}/features/stall.md`]: feature(["stall/**"], ["hang-b"]),
    [`${SKILL}/features/deaf.md`]: feature(["deaf/**"], ["deaf"]),
  });
  put(
    root,
    "node_modules/@antelopejs/core/package.json",
    '{"name":"@antelopejs/core","bin":{"ajs":"ajs.cjs"}}\n',
  );
  put(root, "node_modules/@antelopejs/core/ajs.cjs", AJS);
  return { root, tmp, run: newRun(root, tmp) };
}

test(
  "two journeys that start apps at once each keep their app's record in the run, and both records go once the apps stop; writing back each command's whole state keeps only the last writer's record",
  { skip: TWO_JOBS },
  (t) => {
    const { root, tmp, run } = repo(t);
    const result = verify(root, tmp, [
      "journey",
      run,
      "--features",
      "smoke,apps",
      "--jobs",
      "2",
    ]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(loadRun(run).processes, []);
    assert.deepEqual(
      runEntries(run).filter((name) => name.startsWith("processes-")),
      [],
    );
  },
);

test(
  "two journeys that build the same prepared key at once both pass, and the run keeps the first build to finish; a keep that throws once another journey kept the key fails the second journey",
  { skip: TWO_JOBS },
  (t) => {
    const { root, tmp, run } = repo(t);
    const result = verify(root, tmp, [
      "journey",
      run,
      "--features",
      "left,right",
      "--jobs",
      "2",
    ]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const notes = ["left/prepare-a", "right/prepare-b"]
      .map((path) =>
        read(run, `evidence/${path}/01-prepared-tree/prepared.txt`),
      )
      .map((note) => note.replace(/^.*; /, "").trim())
      .sort();
    assert.equal(notes[0], "kept, so later journeys of the run copy it");
    assert.match(notes[1], /^not kept: \w+\/prepare-[ab] kept tree first/);
  },
);

/** Starts `journey <run> --features <features> --jobs 2`, waits until both features started an app, and returns the call and those apps. */
async function interruptible(t: TestContext, features: string) {
  const { root, tmp, run } = repo(t);
  const barrier = join(tmp, "barrier");
  mkdirSync(barrier, { recursive: true });
  const apps = () =>
    runEntries(barrier)
      .filter((name) => name.startsWith("app-"))
      .map((name) => Number(name.slice(4)));
  const call = spawn(
    process.execPath,
    [
      join(PACKAGE_ROOT, "src/bin/verify.ts"),
      "journey",
      run,
      "--features",
      features,
      "--jobs",
      "2",
    ],
    {
      cwd: root,
      env: { ...process.env, TMPDIR: tmp, ANTELOPEJS_LEASE: "", CI: "1" },
      stdio: "ignore",
    },
  );
  const exited = once(call, "exit");
  for (let waited = 0; apps().length < 2 && waited < 20_000; waited += 50)
    await delay(50);
  const started = apps();
  t.after(() => {
    call.kill("SIGKILL");
    for (const pid of started.filter(alive)) process.kill(pid, "SIGKILL");
  });
  assert.equal(started.length, 2);
  const stopped = async () => {
    for (let waited = 0; started.some(alive) && waited < 5000; waited += 50)
      await delay(50);
    return started.filter(alive);
  };
  return { call, exited, stopped };
}

test(
  "a SIGTERM to a journey --jobs call reaches each feature's process, which stops its app, and the call exits 143; a call that does not forward it exits at once and leaves both apps running",
  { skip: TWO_JOBS || NO_SIGNAL_FORWARDING },
  async (t) => {
    const { call, exited, stopped } = await interruptible(t, "hang,stall");
    call.kill("SIGTERM");
    const [code] = await exited;
    assert.equal(code, 143);
    assert.deepEqual(await stopped(), []);
  },
);

test(
  "a feature process that ignores SIGTERM is killed with its app once the grace period ends, and the call exits 143; a call that only forwards the signal waits for it forever",
  { skip: TWO_JOBS || NO_SIGNAL_FORWARDING },
  async (t) => {
    const { call, exited, stopped } = await interruptible(t, "hang,deaf");
    const sent = Date.now();
    call.kill("SIGTERM");
    const ended = await Promise.race([exited, delay(15_000, ["hung"])]);
    assert.deepEqual(ended, [143, null]);
    assert.ok(Date.now() - sent >= 4000, "the grace period ran");
    assert.deepEqual(await stopped(), []);
  },
);

test(
  "a second interrupt kills a feature process that ignores the first at once, with its app, and the call exits with the first signal's code; a call that waits out the grace period after a repeated signal takes 5 s",
  { skip: TWO_JOBS || NO_SIGNAL_FORWARDING },
  async (t) => {
    const { call, exited, stopped } = await interruptible(t, "hang,deaf");
    const sent = Date.now();
    call.kill("SIGTERM");
    await delay(300);
    call.kill("SIGINT");
    const ended = await Promise.race([exited, delay(15_000, ["hung"])]);
    assert.deepEqual(ended, [143, null]);
    assert.ok(Date.now() - sent < 3000, "the second signal did not wait");
    assert.deepEqual(await stopped(), []);
  },
);
