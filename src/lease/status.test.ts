import assert from "node:assert/strict";
import test from "node:test";

import { statusTable, type LeaseReport } from "./commands.ts";
import { leaseId, type MongoMode } from "./protocol.ts";

function report(mongo: MongoMode, mongod: number | null): LeaseReport {
  const id = leaseId("/work/dms");
  return {
    id,
    state: "live",
    dir: "/leases/one",
    record: {
      version: 1,
      id,
      worktree: "/work/dms",
      gitInode: 7,
      gitBirth: 0,
      ports: {
        api: 21110,
        web: 21111,
        mongo: 21112,
        smtp: 21113,
        inspect: 21114,
        hmr: 21115,
      },
      createdAt: "2026-11-05T00:00:00.000Z",
      mongo,
    },
    mongod,
    listening: [],
    pids: [],
  };
}

function mongodColumn(row: LeaseReport): string | undefined {
  const [header, line] = statusTable([row]).split("\n");
  const column = header?.split(/\s+/u).indexOf("MONGOD") ?? -1;
  return line?.split(/\s+/u)[column];
}

test("status shows the pid of a mongod that still runs after its lease switched to DMS_MONGO_URL (fails when the MONGOD column prints the mode of an external lease instead of the process it still runs)", () => {
  assert.deepEqual(
    [
      mongodColumn(report("external", 4242)),
      mongodColumn(report("external", null)),
      mongodColumn(report("owned", 4242)),
      mongodColumn(report("owned", null)),
    ],
    ["4242", "external", "4242", "-"],
  );
});
