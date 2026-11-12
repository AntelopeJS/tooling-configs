#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runCli } from "../guardrails/cli.ts";
import { parseWeights, testFiles, unweightedFiles } from "./shards.ts";

/** Fails when a test file under `src` has no entry in `test-weights.json`, run from the repository root. */
runCli(() => {
  const weightsPath = fileURLToPath(
    new URL("./test-weights.json", import.meta.url),
  );
  const weights = parseWeights(readFileSync(weightsPath, "utf8"), weightsPath);
  const missing = unweightedFiles(testFiles(), weights);
  if (!missing.length) return 0;
  throw new Error(
    [
      "src/ci/test-weights.json has no weight for these test files, so the shard balancer places them at the median weight:",
      ...missing.map((file) => `  ${file}`),
      "Regenerate it from the test-durations-* artifacts of recent ci.yml runs, this branch's latest run included:",
      "  gh run download <run-id> -p 'test-durations-*' -D <dir>/<run-id>   (once per run)",
      "  pnpm run ci:weights <dir>/*",
    ].join("\n"),
  );
});
