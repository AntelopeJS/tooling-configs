import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { externalEnv, gitInit, leasedEnv, scratch } from "./helpers/cli.ts";
import {
  candidateBases,
  chooseBlock,
  claimPort,
  closeServer,
} from "./ports.ts";
import { leaseId, type LeaseId } from "./protocol.ts";

const KERNEL_EPHEMERAL_START = 32768;
const DENIED = [24678, 27017, 27018, 27019];

function blockOf(base: number): number[] {
  return Array.from({ length: 10 }, (_, offset) => base + offset);
}

test("every candidate block sits below the kernel's ephemeral range, never repeats, and skips the HMR and system mongod ports (fails when the band reaches 32768 or the denylist is dropped)", () => {
  for (const name of ["a", "b", "c", "/home/x/.t3/worktrees/dms/t3-1"]) {
    const bases = candidateBases(leaseId(name));
    const ports = bases.flatMap(blockOf);
    assert.ok(
      ports.every((port) => port >= 1024 && port < KERNEL_EPHEMERAL_START),
    );
    assert.equal(new Set(ports).size, ports.length);
    assert.deepEqual(
      DENIED.filter((port) => ports.includes(port)),
      [],
    );
  }
});

/** Every port except the 19 around each of `centres`: a block of ten fits there only if it holds its centre. */
function takenExceptAround(centres: readonly number[]): Set<number> {
  const open = new Set(
    centres.flatMap((centre) =>
      Array.from({ length: 19 }, (_, offset) => centre - 9 + offset),
    ),
  );
  return new Set(
    Array.from({ length: 65535 }, (_, index) => index + 1).filter(
      (port) => !open.has(port),
    ),
  );
}

test("chooseBlock never hands out a block holding 24678 or 27017-27019, even when nothing else is free (fails when the denylist is dropped)", async () => {
  const id = leaseId("full");
  const free = async () => true;
  await assert.rejects(
    chooseBlock(id, takenExceptAround(DENIED), free),
    /no free port block/u,
  );
  const ports = await chooseBlock(
    id,
    takenExceptAround([...DENIED, 25010]),
    free,
  );
  assert.ok(ports.api >= 25001 && ports.hmr <= 25019, `got ${ports.api}`);
});

test("a foreign listener on a non-api port of the first candidate block moves the lease to another block (fails without a bind probe, or one that probes only the api port)", async (t) => {
  const root = scratch(t);
  const worktree = gitInit(join(root, "w"));
  const [first = 0] = candidateBases(leaseId(worktree));
  const foreign = await claimPort(first + 3);
  t.after(() => (foreign === undefined ? undefined : closeServer(foreign)));
  const printed = await leasedEnv(worktree, externalEnv(join(root, ".home")));
  const api = Number(printed.DMS_BACK_PORT);
  assert.ok(
    api < first || api >= first + 10,
    `api ${api} is in block ${first}`,
  );
});

/** The largest number of the uids 0 to 999 that share a first block with the uid `offset` above them, over every offset from 1 to 1000, and that offset. */
function worstUidOffset(id: LeaseId): { offset: number; shared: number } {
  const firsts = Array.from(
    { length: 2000 },
    (_, uid) => candidateBases(id, uid)[0],
  );
  let worst = { offset: 0, shared: 0 };
  for (let offset = 1; offset <= 1000; offset += 1) {
    const shared = firsts
      .slice(0, 1000)
      .filter((first, uid) => first === firsts[uid + offset]).length;
    if (shared > worst.shared) worst = { offset, shared };
  }
  return worst;
}

test("the first candidate block comes from the lease id and the user id together, so no distance between two uids makes their users share it at one path more than 1 time in 100 (fails when the first block comes from the lease id alone, or from the id's hash plus the uid, which wraps so that uids 999 apart always share it)", () => {
  const worst = worstUidOffset(leaseId("/srv/shared/dms"));
  assert.ok(
    worst.shared <= 10,
    `${worst.shared} of 1000 uid pairs ${worst.offset} apart share a first block`,
  );
});
