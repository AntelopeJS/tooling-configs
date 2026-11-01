import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { stopProcessGroup } from "./stop.ts";

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function start(script: string) {
  const started = spawn("sh", ["-c", script], {
    detached: true,
    stdio: "ignore",
  });
  if (started.pid === undefined) throw new Error("the shell did not start");
  return { started, pid: started.pid };
}

test("stopProcessGroup answers only once a process that winds down slowly is gone", async () => {
  const { started, pid } = start(
    "trap 'sleep 0.4; exit 0' INT; while :; do sleep 0.05; done",
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  await stopProcessGroup(started, 5_000);
  assert.equal(groupAlive(pid), false);
});

test("stopProcessGroup kills a process group that ignores the interrupt", async () => {
  const { started, pid } = start("trap '' INT; while :; do sleep 0.05; done");
  await new Promise((resolve) => setTimeout(resolve, 200));
  await stopProcessGroup(started, 300);
  assert.equal(groupAlive(pid), false);
});
