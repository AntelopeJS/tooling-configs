import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

import { stopProcessGroup } from "./stop.ts";

const QUICK = { graceMs: 300, killWaitMs: 2_000 };
const started: number[] = [];
const NO_GROUPS =
  process.platform === "win32" &&
  "Windows has no process groups or SIGINT, and the scripts need sh traps";

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Starts `script` as the leader of its own process group and answers once it has printed `up`. */
async function start(script: string) {
  const child = spawn("sh", ["-c", script], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (child.pid === undefined) throw new Error("the shell did not start");
  started.push(child.pid);
  await once(child.stdout, "data");
  child.stdout.resume();
  return { child, pid: child.pid };
}

test.afterEach(() => {
  for (const pid of started.splice(0))
    if (groupAlive(pid)) process.kill(-pid, "SIGKILL");
});

const NESTED = `const { spawn } = require("node:child_process");
const inner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log(inner.pid);
setInterval(() => {}, 1000);`;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("stopProcessGroup ends a child and the process it started, where an implementation that signals the leader alone leaves the inner process running", async () => {
  const child = spawn(process.execPath, ["-e", NESTED], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const [chunk] = await once(child.stdout, "data");
  child.stdout.resume();
  const inner = Number(String(chunk).trim());
  try {
    await stopProcessGroup(child, QUICK);
    const outer = child.pid ?? 0;
    for (let waited = 0; pidAlive(inner) && waited < 2_000; waited += 50)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual([pidAlive(outer), pidAlive(inner)], [false, false]);
  } finally {
    if (pidAlive(inner)) process.kill(inner, "SIGKILL");
  }
});

test(
  "stopProcessGroup answers only once a group that winds down slowly is gone",
  { skip: NO_GROUPS },
  async () => {
    const { child, pid } = await start(
      "trap 'sleep 0.4; exit 0' INT; echo up; while :; do sleep 0.05; done",
    );
    await stopProcessGroup(child, { graceMs: 5_000, killWaitMs: 2_000 });
    assert.equal(groupAlive(pid), false);
  },
);

test(
  "stopProcessGroup kills a group that ignores the interrupt",
  { skip: NO_GROUPS },
  async () => {
    const { child, pid } = await start(
      "trap '' INT; echo up; while :; do sleep 0.05; done",
    );
    await assert.doesNotReject(stopProcessGroup(child, QUICK));
    assert.equal(groupAlive(pid), false);
  },
);

test(
  "stopProcessGroup stops a child that outlives the group's leader",
  { skip: NO_GROUPS },
  async () => {
    const { child, pid } = await start(
      "trap 'exit 0' INT; sh -c 'trap \"\" INT; while :; do sleep 0.05; done' & echo up; wait",
    );
    await assert.doesNotReject(stopProcessGroup(child, QUICK));
    assert.equal(groupAlive(pid), false);
  },
);
