import assert from "node:assert/strict";
import test from "node:test";

import { stableShot } from "./stable.ts";

function sequence(frames: string[]) {
  let index = 0;
  return {
    shoot: () =>
      Promise.resolve(
        Buffer.from(frames[Math.min(index++, frames.length - 1)] ?? ""),
      ),
    taken: () => index,
  };
}

const QUICK = { stableShots: 3, maxShots: 10, pauseMs: 0 };

test("stableShot answers the page's last look once it stops changing", async () => {
  const { shoot } = sequence([
    "fallback font",
    "address filled",
    "settled",
    "settled",
    "settled",
  ]);
  assert.equal((await stableShot(shoot, QUICK)).toString(), "settled");
});

test("stableShot does not accept a look that held for fewer shots than asked", async () => {
  const { shoot, taken } = sequence(["early", "early", "late", "late", "late"]);
  assert.equal((await stableShot(shoot, QUICK)).toString(), "late");
  assert.equal(taken(), 5);
});

test("stableShot fails when the page never stops changing", async () => {
  let n = 0;
  await assert.rejects(
    stableShot(() => Promise.resolve(Buffer.from(String(n++))), QUICK),
    /did not stop changing after 10 shots/,
  );
});
