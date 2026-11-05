#!/usr/bin/env node
import { CHECKS_SKIP_ENV, runChecks } from "../guardrails/checks.ts";
import { runCli } from "../guardrails/cli.ts";
import { repositoryRoot } from "../guardrails/files.ts";

runCli(() => {
  const result = runChecks(repositoryRoot(), process.env[CHECKS_SKIP_ENV]);
  process.stdout.write(result.output);
  return result.failed ? 1 : 0;
});
