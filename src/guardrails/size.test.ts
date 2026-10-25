import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { formatCeilings, MAX_FILE_BYTES } from "./ceilings.ts";
import { bin, commit, put, testRepo } from "./helpers/test-repo.ts";

test("size catches untracked tests and real byte excess, not only tracked source or character counts", (t) => {
  const root = testRepo(t);
  for (const path of [
    "pnpm-lock.yaml",
    "package-lock.json",
    "nested/yarn.lock",
    "docs/guide.md",
    "CHANGELOG.md",
    "fixtures/large.ts",
    "src/__fixtures__/large.ts",
    "dist/large.js",
    "src/code.generated.ts",
    "src/__snapshots__/large.snap",
    "image.png",
  ])
    put(root, path, "x".repeat(MAX_FILE_BYTES + 1));
  put(root, "boundary.ts", "x".repeat(MAX_FILE_BYTES));
  put(root, "deleted.ts", "x".repeat(MAX_FILE_BYTES + 1));
  commit(root);
  rmSync(join(root, "deleted.ts"));
  assert.equal(bin(root, "check-size").status, 0);
  put(root, "src/clock.test.ts", "é".repeat(10_001));
  const result = bin(root, "check-size");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/clock.test.ts: 20002 bytes, 2 bytes over/);
  for (const text of [
    "sibling modules",
    "one cohesive group of exports",
    "public entry point",
    "one file per describe",
    "Do not minify, strip whitespace",
    "excluded path",
  ])
    assert.ok(result.stderr.includes(text), text);
  assert.equal(
    bin(root, "check-size", ["boundary.ts", "deleted.ts"]).status,
    0,
  );
  assert.equal(bin(root, "check-size", ["src/clock.test.ts"]).status, 1);
});

test("size honours a recorded allowance but rejects one byte of growth instead of exempting the path", (t) => {
  const root = testRepo(t);
  put(root, "large.ts", "x".repeat(20_123));
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({ rules: {}, oversizeFiles: { "large.ts": 20_123 } }),
  );
  assert.equal(bin(root, "check-size").status, 0);
  put(root, "large.ts", "x".repeat(20_124));
  const result = bin(root, "check-size", ["large.ts"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /1 bytes over the 20123-byte ceiling/);
});
