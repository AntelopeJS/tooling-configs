import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

import { packedPack } from "./helpers/packed-pack.ts";

test("antelopejs-sync --check from a pnpm-packed tarball of the pack passes, where a toolingVersions that reads packageManager from the installed manifest fails because pnpm pack strips that field", async (t) => {
  const { source, packed } = await packedPack(t);
  const result = spawnSync(
    process.execPath,
    [join(packed, "dist", "bin", "sync.mjs"), "--check"],
    { cwd: source, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /^Guardrails are in sync\.$/m);
});
