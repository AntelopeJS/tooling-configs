#!/usr/bin/env node
import { parseArgs } from "node:util";

import { runCli } from "../guardrails/cli.ts";
import { repositoryRoot } from "../guardrails/files.ts";
import { ratchet } from "../guardrails/ratchet.ts";

runCli(() => {
  const { values } = parseArgs({ options: { update: { type: "boolean" } } });
  const result = ratchet(repositoryRoot(), values.update);
  for (const message of result.lowered)
    process.stdout.write(`Lowered ${message}\n`);
  for (const message of result.failures) process.stderr.write(`${message}\n`);
  if (!result.failures.length)
    process.stdout.write("Ratchet: within ceilings.\n");
  return result.failures.length ? 1 : 0;
});
