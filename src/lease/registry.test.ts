import assert from "node:assert/strict";
import test from "node:test";

import type { ParsedRecord } from "./protocol.ts";
import { leaseId } from "./protocol.ts";
import { leaseState, type LeaseFacts } from "./registry.ts";

const BIRTH = 1_700_000_000_000.25;
const record: ParsedRecord = {
  kind: "current",
  record: {
    version: 1,
    id: leaseId("/work/dms"),
    worktree: "/work/dms",
    gitInode: 4242,
    gitBirth: BIRTH,
    ports: { api: 1, web: 2, mongo: 3, smtp: 4, inspect: 5, hmr: 6 },
    createdAt: "2026-11-05T00:00:00.000Z",
    mongo: "owned",
  },
};
const gone: LeaseFacts["git"] = { kind: "gone" };

function present(inode: number, birth: number): LeaseFacts["git"] {
  return { kind: "present", identity: { inode, birth } };
}

function label(parsed: ParsedRecord | undefined, facts: LeaseFacts): string {
  const state = leaseState(parsed, facts);
  if (state.kind === "unreadable") return `${state.kind}:${state.code}`;
  return state.kind === "stale" || state.kind === "orphaned"
    ? `${state.kind}:${state.reason}`
    : state.kind;
}

test("leaseState reads a .git entry with the recorded inode but a new birth time as recreated (fails when identity is the .git inode alone, which ext4 often hands to the next checkout at the same path)", () => {
  assert.equal(
    label(record, { git: present(4242, 1_800_000_000_000), serving: false }),
    "stale:recreated",
  );
});

test("leaseState keeps a lease live when the filesystem records no birth time (fails when a missing birth time reads as a new checkout and deletes live data)", () => {
  assert.equal(
    label(record, { git: present(4242, 0), serving: false }),
    "live",
  );
  assert.equal(
    label(record, { git: present(4242, BIRTH), serving: true }),
    "live",
  );
});

test("leaseState tells a deleted, a recreated and a still-serving checkout apart (fails when a serving stale lease is reported sweepable, or a new inode passes as the same checkout)", () => {
  assert.deepEqual(
    [
      label(record, { git: gone, serving: false }),
      label(record, { git: gone, serving: true }),
      label(record, { git: present(7, BIRTH), serving: false }),
      label(record, { git: present(7, BIRTH), serving: true }),
      label(undefined, { git: gone, serving: false }),
      label({ kind: "foreign", reserved: [1] }, { git: gone, serving: false }),
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

test("leaseState keeps a lease whose .git entry cannot be read as unreadable, never stale (fails when any stat error reads as a deleted worktree, which kills the mongod and deletes the data of a checkout that still exists)", () => {
  for (const serving of [false, true])
    assert.equal(
      label(record, { git: { kind: "unreadable", code: "EACCES" }, serving }),
      "unreadable:EACCES",
    );
});
