#!/usr/bin/env node
import { parseArgs } from "node:util";

import { createGraphql, ghToken } from "../garden/api.ts";
import { runCliAsync } from "../guardrails/cli.ts";
import { lines, triage } from "../triage/triage.ts";

await runCliAsync(async () => {
  const { values } = parseArgs({ options: { json: { type: "boolean" } } });
  const shortlist = await triage(createGraphql(ghToken()));
  if (values.json)
    process.stdout.write(`${JSON.stringify(shortlist, null, 2)}\n`);
  else for (const line of lines(shortlist)) process.stdout.write(`${line}\n`);
  return 0;
});
