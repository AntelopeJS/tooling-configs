import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseWeights } from "./shards.ts";

const REPORTER = new URL("./file-reporter.ts", import.meta.url).href;

test("the file reporter prints seconds per test file, keyed by the path relative to the working directory with / separators", (t) => {
  const root = mkdtempSync(join(tmpdir(), "file-reporter-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "nested"));
  writeFileSync(
    join(root, "nested", "sample.test.ts"),
    [
      'import test from "node:test";',
      'test("one", async () => { await new Promise((done) => setTimeout(done, 60)); });',
      'test("two", async (t) => { await t.test("nested", () => {}); });',
      "",
    ].join("\n"),
  );
  const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
  const run = spawnSync(
    process.execPath,
    ["--test", `--test-reporter=${REPORTER}`, "nested/sample.test.ts"],
    { cwd: root, encoding: "utf8", env },
  );
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const durations = parseWeights(run.stdout, "reporter output");
  assert.deepEqual(Object.keys(durations), ["nested/sample.test.ts"]);
  assert.ok(
    durations["nested/sample.test.ts"]! >= 0.05,
    "counts the 60 ms test",
  );
  assert.ok(durations["nested/sample.test.ts"]! < 5, "reports seconds, not ms");
});
