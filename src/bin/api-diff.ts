#!/usr/bin/env node
import { apiDiff } from "../guardrails/api-diff.ts";
import { runCli } from "../guardrails/cli.ts";
import { repositoryRoot } from "../guardrails/files.ts";

runCli(() => {
  const args = process.argv.slice(2);
  if (args.length !== 1)
    throw new Error("Usage: antelopejs-api-diff <base-ref>");
  const result = apiDiff(repositoryRoot(), args[0]);
  process.stdout.write(result.output);
  return result.different ? 1 : 0;
});
