#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runCli } from "../guardrails/cli.ts";
import { parseWeights, shardFiles, testFiles } from "./shards.ts";

/** Prints the test files shard `SHARD` of `TOTAL` runs, one per line, from the repository root. */
runCli(() => {
  const weightsPath = fileURLToPath(
    new URL("./test-weights.json", import.meta.url),
  );
  const weights = parseWeights(readFileSync(weightsPath, "utf8"), weightsPath);
  const mine = shardFiles(
    testFiles(),
    weights,
    Number(process.env.SHARD),
    Number(process.env.TOTAL),
  );
  process.stdout.write(`${mine.join("\n")}\n`);
  return 0;
});
