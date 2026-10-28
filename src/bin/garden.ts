#!/usr/bin/env node
import { parseArgs } from "node:util";

import { createApi, ghToken } from "../garden/api.ts";
import { failureLines, garden } from "../garden/run.ts";
import { runCliAsync } from "../guardrails/cli.ts";

await runCliAsync(async () => {
  const { values } = parseArgs({
    options: {
      json: { type: "boolean" },
      "apply-pauses": { type: "boolean" },
    },
  });
  const outcome = await garden(createApi(ghToken()), {
    applyPauses: values["apply-pauses"] === true,
  });
  if (values.json)
    process.stdout.write(`${JSON.stringify(outcome.report, null, 2)}\n`);
  else
    for (const line of failureLines(outcome)) process.stdout.write(`${line}\n`);
  return outcome.failures.length ? 1 : 0;
});
