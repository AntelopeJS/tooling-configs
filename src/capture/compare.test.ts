import assert from "node:assert/strict";
import test from "node:test";

import { changedRatio, MAX_CHANGED_RATIO, withinTolerance } from "./compare.ts";

function image(width: number, height: number, fill: number) {
  return { width, height, data: new Uint8Array(width * height * 4).fill(fill) };
}

test("two equal images changed nothing", () => {
  assert.equal(changedRatio(image(100, 100, 40), image(100, 100, 40)), 0);
});

test("the ratio is the share of pixels that differ", () => {
  const changed = image(100, 100, 40);
  for (let pixel = 0; pixel < 10; pixel += 1) changed.data.fill(255, pixel * 4, pixel * 4 + 4);
  assert.equal(changedRatio(image(100, 100, 40), changed), 10 / 10_000);
});

test("images of two sizes changed everything", () => {
  assert.equal(changedRatio(image(100, 100, 40), image(100, 101, 40)), 1);
});

test("the tolerance is 0.1% of the pixels, the limit included", () => {
  assert.equal(MAX_CHANGED_RATIO, 0.001);
  assert.equal(withinTolerance(0.001), true);
  assert.equal(withinTolerance(0.0010001), false);
  assert.equal(withinTolerance(0), true);
});
