#!/usr/bin/env node
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCli } from "../guardrails/cli.ts";
import { meanWeights, parseWeights } from "./shards.ts";

const WEIGHTS_PATH = fileURLToPath(
  new URL("./test-weights.json", import.meta.url),
);

/**
 * Rewrites `test-weights.json` as the per-file mean of every `durations.json` under the directories given, the layout
 * `gh run download <id> -D <dir>` leaves for the `test-durations-*` artifacts.
 */
runCli(() => {
  const directories = process.argv.slice(2);
  if (!directories.length)
    throw new Error("usage: refresh-weights.ts <downloaded-run-directory>...");
  const measurements = directories.flatMap((directory) =>
    globSync("**/durations.json", { cwd: directory }).map((path) =>
      parseWeights(readFileSync(join(directory, path), "utf8"), path),
    ),
  );
  if (!measurements.length)
    throw new Error(`no durations.json under ${directories.join(" ")}`);
  writeFileSync(
    WEIGHTS_PATH,
    `${JSON.stringify(meanWeights(measurements), null, 2)}\n`,
  );
  return 0;
});
