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

test("a PR that fixes one finding and keeps the others with their base lengths passes, naming the fix; a gate that demands the base's exact set fails it", () => {
  const base = {
    ...SAME,
    violated: [...SAME.violated, "Fifo"],
    lengths: { ...SAME.lengths, Fifo: 3 },
  };
  assert.deepEqual(formalGate(changed({ base, fixed: ["Fifo"] })), {
    fails: false,
    outcome:
      "covered behaviour changed (emit), same known findings as base: NoOverlapOnInstance, NoLostTask; fixed: Fifo",
  });
});

test("a rule the base broke that HEAD neither breaks nor reports fixed is not known; a gate that only checks HEAD's rules against the base passes it", () => {
  const base = {
    ...SAME,
    violated: [...SAME.violated, "Fifo"],
    lengths: { ...SAME.lengths, Fifo: 3 },
  };
  assert.equal(formalGate(changed({ base })).fails, true);
});

test("a rule HEAD breaks that the base did not is new, even when the base printed the same length for it; a gate that compares lengths alone passes it", () => {
  assert.equal(
    formalGate(
      changed({
        violated: [...SAME.violated, "Fifo"],
        lengths: { ...SAME.lengths, Fifo: 3 },
        base: { ...SAME, lengths: { ...SAME.lengths, Fifo: 3 } },
      }),
    ).fails,
    true,
  );
});

test("a rule named after an Object.prototype key with no recorded length on either side fails; a lookup that reads inherited keys compares Object with Object and passes it", () => {
  const empty = {
    exitCode: 0,
    violated: ["constructor"],
    passing: [],
    lengths: {},
  };
  assert.equal(formalGate(changed({ ...empty, base: empty })).fails, true);
});
