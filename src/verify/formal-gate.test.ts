import assert from "node:assert/strict";
import test from "node:test";

import { formalGate, type FormalResult } from "./formal.ts";

const SAME = {
  exitCode: 0,
  violated: ["NoOverlapOnInstance", "NoLostTask"],
  passing: [],
  lengths: { NoOverlapOnInstance: 5, NoLostTask: 7 },
};

function changed(overrides: Partial<FormalResult>): FormalResult {
  return {
    name: "formal-scheduler",
    folder: "formal/formal-scheduler",
    behaviour: { changed: true, method: "emit", removed: [], added: [] },
    checkChanged: false,
    base: SAME,
    fixed: [],
    missing: [],
    ...SAME,
    ...overrides,
  };
}

test("the same findings as the base, each with its base length, are known", () => {
  assert.deepEqual(formalGate(changed({})), {
    fails: false,
    outcome:
      "covered behaviour changed (emit), same known findings as base: NoOverlapOnInstance, NoLostTask",
  });
});

test("the same findings fail when the base run exited non-zero", () => {
  assert.equal(
    formalGate(changed({ base: { ...SAME, exitCode: 1 } })).fails,
    true,
  );
});

test("the same findings fail when the base was not run", () => {
  assert.equal(formalGate(changed({ base: null })).fails, true);
});

test("the same findings fail when HEAD recorded no counterexample lengths", () => {
  assert.equal(formalGate(changed({ lengths: undefined })).fails, true);
});

test("the same findings fail when the base recorded no length for one of them", () => {
  const base = { ...SAME, lengths: { NoLostTask: 7 } };
  assert.equal(formalGate(changed({ base })).fails, true);
});

test("a base that broke one more rule than HEAD reports passing is not the same set", () => {
  const base = {
    ...SAME,
    violated: [...SAME.violated, "Fifo"],
    lengths: { ...SAME.lengths, Fifo: 3 },
  };
  assert.deepEqual(formalGate(changed({ base, fixed: ["Fifo"] })), {
    fails: true,
    outcome:
      "covered behaviour changed (emit), violated NoOverlapOnInstance, NoLostTask; fixed: Fifo",
  });
});
