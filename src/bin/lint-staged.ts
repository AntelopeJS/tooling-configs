#!/usr/bin/env node
import { runCli } from "../guardrails/cli.ts";
import { repositoryRoot } from "../guardrails/files.ts";
import { lintStaged } from "../guardrails/oxlint.ts";

runCli(() => {
  const report = lintStaged(repositoryRoot(), process.argv.slice(2));
  for (const line of report.skipped) process.stdout.write(`${line}\n`);
  for (const line of report.findings) process.stderr.write(`${line}\n`);
  return report.failed ? 1 : 0;
});
