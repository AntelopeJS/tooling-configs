import assert from "node:assert/strict";
import test from "node:test";

import { zip } from "./helpers/fake-api.ts";
import { firstZipEntry } from "./zip.ts";

test("a deflated and a stored entry both decode, not only the stored one", () => {
  const report = JSON.stringify({ files: { "a.ts": { mutants: [] } } });
  assert.equal(firstZipEntry(zip("mutation.json", report)), report);
  assert.equal(firstZipEntry(zip("mutation.json", report, false)), report);
});

test("bytes that are not a ZIP archive are rejected rather than read as an empty report", () => {
  assert.throws(() => firstZipEntry(new Uint8Array(40)), /Not a ZIP archive/);
});
