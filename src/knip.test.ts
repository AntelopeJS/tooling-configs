import assert from "node:assert/strict";
import { test } from "node:test";
import { antelopeKnipConfig } from "./knip.ts";

test("the default project and entry cover .ts, .mts and .mjs scripts", () => {
  const config = JSON.stringify(antelopeKnipConfig());
  const glob = "scripts/**/*.{ts,mts,mjs}";
  assert.equal(config.split(glob).length - 1, 2);
});
