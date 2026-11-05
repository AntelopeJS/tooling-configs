import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { leaseEnv, type Lease } from "./env.ts";
import { envFor, gitInit, leasedEnv, scratch } from "./helpers/cli.ts";
import { leaseId } from "./protocol.ts";

const id = leaseId("/work/dms");
const lease: Lease = {
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
    mongo: "owned",
  },
};
const parent = { PORT: "5010", PATH: "/usr/bin", MONGO_URL: "mongodb://x" };

test("leaseEnv drops an inherited PORT and maps every role variable onto its own port (fails when PORT leaks into both servers or two roles swap ports)", () => {
  const env = leaseEnv(lease, parent);
  assert.equal(Object.hasOwn(env, "PORT"), false);
  assert.equal(env.PATH, "/usr/bin");
  assert.deepEqual(
    [
      env.DMS_BACK_PORT,
      env.DMS_FRONT_PORT,
      env.DMS_SMTP_PORT,
      env.DMS_INSPECT_PORT,
      env.DMS_CLIENT_BASE_URL,
      env.MONGO_URL,
      env.MONGO_DATABASE,
      env.ANTELOPEJS_LEASE,
    ],
    [
      "21110",
      "21111",
      "21113",
      "21114",
      "http://localhost:21111",
      "mongodb://127.0.0.1:21112",
      `dms_${id}`,
      id,
    ],
  );
  assert.deepEqual(
    [env.DMS_BACK_LOG, env.DMS_FRONT_LOG, env.TMPDIR, env.ANTELOPEJS_LEASE_DIR],
    [
      "/leases/one/logs/back.log",
      "/leases/one/logs/front.log",
      "/leases/one/tmp",
      "/leases/one",
    ],
  );
});

test("leaseEnv leaves DMS_API_BASE_URL unset, so the dashboard finds the backend through .antelope/dev.json (fails when the leased api port is exported, which points the dashboard at an empty port wherever the backend config hard-codes 5010)", () => {
  assert.equal(
    Object.hasOwn(leaseEnv(lease, parent), "DMS_API_BASE_URL"),
    false,
  );
});

test("leaseEnv sets PORT to the api or web port only for --as (fails when --as is ignored or picks the other server)", () => {
  assert.equal(leaseEnv(lease, parent, "api").PORT, "21110");
  assert.equal(leaseEnv(lease, parent, "web").PORT, "21111");
});

test("DMS_MONGO_URL replaces the lease's mongod in MONGO_URL and keeps the lease's database (fails when an external server is ignored or shared under one database)", () => {
  const env = leaseEnv(lease, { DMS_MONGO_URL: "mongodb://shared:27017" });
  assert.equal(env.MONGO_URL, "mongodb://shared:27017");
  assert.equal(env.MONGO_DATABASE, `dms_${id}`);
});

test("run strips the caller's PORT and hands --as web the web port (fails when the bin does not pass --as through to the command)", async (t) => {
  const root = scratch(t);
  const worktree = gitInit(join(root, "w"));
  const env = envFor(join(root, ".home"), {
    PORT: "5010",
    DMS_MONGO_URL: "mongodb://127.0.0.1:1",
  });
  const plain = await leasedEnv(worktree, env);
  assert.equal(Object.hasOwn(plain, "PORT"), false);
  const web = await leasedEnv(worktree, env, ["--as", "web"]);
  assert.equal(web.PORT, plain.DMS_FRONT_PORT);
});
