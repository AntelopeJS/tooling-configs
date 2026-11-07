import assert from "node:assert/strict";
import test from "node:test";

import {
  assignShards,
  meanWeights,
  parseWeights,
  shardFiles,
} from "./shards.ts";

const WEIGHTS = { a: 10, b: 6, c: 5, d: 4, e: 3 };

test("assignShards places the heaviest file first on the least loaded shard, which round-robin or path order would not", () => {
  assert.deepEqual(assignShards(["a", "b", "c", "d", "e"], WEIGHTS, 2), [
    ["a", "d"],
    ["b", "c", "e"],
  ]);
});

test("assignShards gives the same shards whatever order the files are listed in", () => {
  const files = ["e", "c", "a", "d", "b"];
  assert.deepEqual(
    assignShards(files, WEIGHTS, 2),
    assignShards(files.toReversed(), WEIGHTS, 2),
  );
});

test("assignShards weighs a file missing from the weights as the median of the known ones, not zero", () => {
  assert.deepEqual(
    assignShards(["a", "b", "c", "z"], { a: 9, b: 1, c: 5 }, 2),
    [
      ["a", "b"],
      ["c", "z"],
    ],
  );
});

test("assignShards breaks a weight tie by path", () => {
  assert.deepEqual(assignShards(["y", "x"], { x: 1, y: 1 }, 2), [["x"], ["y"]]);
});

test("shardFiles over every shard runs each file exactly once", () => {
  const files = ["a", "b", "c", "d", "e", "f"];
  const ran = [1, 2, 3].flatMap((shard) =>
    shardFiles(files, WEIGHTS, shard, 3),
  );
  assert.deepEqual(ran.toSorted(), files);
});

test("shardFiles lists the heaviest file first, so none starts last and runs alone at the tail", () => {
  assert.deepEqual(shardFiles(["a", "b", "c"], { a: 1, b: 9, c: 5 }, 1, 1), [
    "b",
    "c",
    "a",
  ]);
});

test("shardFiles fails a shard that would run no file", () => {
  assert.throws(
    () => shardFiles(["a"], WEIGHTS, 2, 2),
    /shard 2 runs no test file/,
  );
});

test("shardFiles fails a path that node --test would read as a glob or split on whitespace", () => {
  for (const odd of ["src/a[1].test.ts", "src/a b.test.ts", "src/a*.test.ts"])
    assert.throws(
      () => shardFiles(["src/ok.test.ts", odd], WEIGHTS, 1, 2),
      /rename these test files: .*[ab]/,
    );
});

test("shardFiles rejects a shard outside 1..total", () => {
  for (const shard of [0, 3, 1.5, Number.NaN])
    assert.throws(
      () => shardFiles(["a", "b"], WEIGHTS, shard, 2),
      /is not a valid shard/,
    );
});

test("meanWeights averages repeated files to one decimal and sorts by path", () => {
  assert.deepEqual(
    meanWeights([{ "b.test.ts": 1, "a.test.ts": 2 }, { "b.test.ts": 2.2 }]),
    { "a.test.ts": 2, "b.test.ts": 1.6 },
  );
  assert.deepEqual(
    Object.keys(meanWeights([{ "b.test.ts": 1, "a.test.ts": 2 }])),
    ["a.test.ts", "b.test.ts"],
  );
});

test("parseWeights rejects a weight that is not a number", () => {
  assert.deepEqual(parseWeights('{"a":1.5}', "weights"), { a: 1.5 });
  assert.throws(
    () => parseWeights('{"a":"slow"}', "weights"),
    /a: expected a number/,
  );
});
