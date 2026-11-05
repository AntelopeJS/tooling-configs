import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  envFor,
  externalEnv,
  gitInit,
  lease,
  leasedEnv,
  scratch,
} from "./helpers/cli.ts";
import { candidateBases } from "./ports.ts";
import { leaseId } from "./protocol.ts";

test("a v1 lease.json written by any version, with fields this one does not know, is reused as is (fails when a record field is renamed or unknown fields are rejected)", async (t) => {
  const root = scratch(t);
  const home = join(root, ".home");
  const worktree = gitInit(join(root, "w"));
  const id = leaseId(worktree);
  const git = statSync(join(worktree, ".git"));
  mkdirSync(join(home, id), { recursive: true });
  writeFileSync(
    join(home, id, "lease.json"),
    JSON.stringify({
      version: 1,
      id,
      worktree,
      gitInode: git.ino,
      gitBirth: git.birthtimeMs,
      ports: {
        api: 29000,
        web: 29001,
        mongo: 29002,
        smtp: 29003,
        inspect: 29004,
        hmr: 29005,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      mongo: "external",
      addedLater: { by: "a newer minor version" },
    }),
  );
  const printed = await leasedEnv(worktree, externalEnv(home));
  assert.equal(printed.DMS_BACK_PORT, "29000");
  assert.equal(printed.DMS_INSPECT_PORT, "29004");
});

test("a record of an unknown version keeps its ports and survives gc (fails when an older version deletes or reuses a newer version's lease)", async (t) => {
  const root = scratch(t);
  const home = join(root, ".home");
  const worktree = gitInit(join(root, "w"));
  const [first = 0] = candidateBases(leaseId(worktree));
  const foreign = join(home, "ffffffffff");
  mkdirSync(foreign, { recursive: true });
  writeFileSync(
    join(foreign, "lease.json"),
    JSON.stringify({ version: 2, ports: { api: first, web: first + 1 } }),
  );
  const env = externalEnv(home);
  const then = new Date(Date.now() - 30 * 86_400_000);
  utimesSync(foreign, then, then);
  assert.equal((await lease(["gc", "--idle", "1"], root, env)).code, 0);
  assert.equal(existsSync(join(foreign, "lease.json")), true);
  const api = Number((await leasedEnv(worktree, env)).DMS_BACK_PORT);
  assert.ok(
    api < first || api >= first + 10,
    `api ${api} is in block ${first}`,
  );
});

test("without ANTELOPEJS_LEASE_HOME the registry is ~/.antelopejs/leases (fails when the default path moves, which splits the registry between versions)", async (t) => {
  const root = scratch(t);
  const worktree = gitInit(join(root, "w"));
  const env = envFor("", {
    HOME: root,
    DMS_MONGO_URL: "mongodb://127.0.0.1:1",
  });
  const { ANTELOPEJS_LEASE_HOME: _unset, ...withoutHome } = env;
  const printed = await leasedEnv(worktree, withoutHome);
  const id = String(printed.ANTELOPEJS_LEASE);
  assert.equal(
    existsSync(join(root, ".antelopejs", "leases", id, "lease.json")),
    true,
  );
});

test("a relative ANTELOPEJS_LEASE_HOME is refused before any lease opens (fails when the value resolves against each cwd, which splits the registry by subdirectory and hands commands a relative TMPDIR)", async (t) => {
  const root = scratch(t);
  const worktree = gitInit(join(root, "w"));
  const env = envFor("rel", { DMS_MONGO_URL: "mongodb://127.0.0.1:1" });
  for (const args of [["run", "--", "true"], ["status"], ["down"], ["gc"]]) {
    const outcome = await lease(args, worktree, env);
    assert.equal(outcome.code, 1, args.join(" "));
    assert.match(
      outcome.stderr,
      /ANTELOPEJS_LEASE_HOME must be an absolute path, not rel/u,
    );
  }
  assert.equal(existsSync(join(worktree, "rel")), false);
});
