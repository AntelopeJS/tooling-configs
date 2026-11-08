import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bytesOf } from "./helpers/files.ts";
import { keepDemoLogs } from "./logs.ts";

test("keepDemoLogs copies the demo logs out of a checkout that is then deleted, and names where", () => {
  const demo = mkdtempSync(join(tmpdir(), "capture-logs-"));
  mkdirSync(join(demo, ".antelope", "capture"), { recursive: true });
  writeFileSync(
    join(demo, ".antelope", "capture", "backend.log"),
    "Cannot find module dist/index.js\n",
  );
  const [line] = keepDemoLogs(demo);
  rmSync(demo, { recursive: true, force: true });
  const kept = /^the demo logs are kept in (\S+)$/.exec(line ?? "")?.[1];
  assert.ok(kept, `no kept directory in ${line}`);
  try {
    assert.equal(
      bytesOf(join(kept, "backend.log")).toString(),
      "Cannot find module dist/index.js\n",
    );
  } finally {
    rmSync(kept, { recursive: true, force: true });
  }
});

test("a demo that wrote no log keeps nothing", (t) => {
  const demo = mkdtempSync(join(tmpdir(), "capture-logs-"));
  t.after(() => rmSync(demo, { recursive: true, force: true }));
  assert.deepEqual(keepDemoLogs(demo), []);
});
