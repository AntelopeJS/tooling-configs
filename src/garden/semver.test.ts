import assert from "node:assert/strict";
import test from "node:test";

import { admits } from "./semver.ts";

test("a 0.x caret stops at the next minor, so a range that skips the newest minor excludes it", () => {
  assert.equal(admits("^0.2.3", "0.2.9"), true);
  assert.equal(admits("^0.2.3", "0.3.0"), false);
  assert.equal(admits(">=0.7.1 <0.8.0", "0.9.0"), false);
});

test("a tilde, an exact pin, alternatives and wildcards each follow their npm meaning", () => {
  assert.equal(admits("~1.4.2", "1.4.9"), true);
  assert.equal(admits("~1.4.2", "1.5.0"), false);
  assert.equal(admits("1.4.2", "1.4.3"), false);
  assert.equal(admits("<1.0.0 || >=2.0.0 <3.0.0", "2.5.0"), true);
  assert.equal(admits("*", "9.9.9"), true);
  assert.equal(admits("workspace:*", "9.9.9"), true);
});
