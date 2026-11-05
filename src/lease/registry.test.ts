import assert from "node:assert/strict";
import test from "node:test";

import type { ParsedRecord } from "./protocol.ts";
import { leaseId } from "./protocol.ts";
import { leaseState, type LeaseFacts } from "./registry.ts";

const record: ParsedRecord = {
  kind: "current",
  record: {
    version: 1,
    id: leaseId("/work/dms"),
    worktree: "/work/dms",
    gitInode: 4242,
    gitBirth: 1_700_000_000_000.25,
    ports: { api: 1, web: 2, mongo: 3, smtp: 4, inspect: 5, hmr: 6 },
    createdAt: "2026-11-05T00:00:00.000Z",
    mongo: "owned",
  },
};
const same = { inode: 4242, birth: 1_700_000_000_000.25 };

function label(parsed: ParsedRecord | undefined, facts: LeaseFacts): string {
  const state = leaseState(parsed, facts);
  return state.kind === "stale" || state.kind === "orphaned"
    ? `${state.kind}:${state.reason}`
    : state.kind;
}

test("leaseState reads a .git entry with the recorded inode but a new birth time as recreated (fails when identity is the .git inode alone, which ext4 often hands to the next checkout at the same path)", () => {
  assert.equal(
    label(record, {
      git: { inode: 4242, birth: 1_800_000_000_000 },
      serving: false,
    }),
    "stale:recreated",
  );
});

test("leaseState keeps a lease live when the filesystem records no birth time (fails when a missing birth time reads as a new checkout and deletes live data)", () => {
  assert.equal(
    label(record, { git: { inode: 4242, birth: 0 }, serving: false }),
    "live",
  );
  assert.equal(label(record, { git: same, serving: true }), "live");
});

test("leaseState tells a deleted, a recreated and a still-serving checkout apart (fails when a serving stale lease is reported sweepable, or a new inode passes as the same checkout)", () => {
  assert.deepEqual(
    [
      label(record, { git: undefined, serving: false }),
      label(record, { git: undefined, serving: true }),
      label(record, { git: { inode: 7, birth: same.birth }, serving: false }),
      label(record, { git: { inode: 7, birth: same.birth }, serving: true }),
      label(undefined, { git: undefined, serving: false }),
      label(
        { kind: "foreign", reserved: [1] },
        { git: undefined, serving: false },
      ),
    ],
    [
      "stale:missing",
      "orphaned:missing",
      "stale:recreated",
      "orphaned:recreated",
      "claiming",
      "foreign",
    ],
  );
});
