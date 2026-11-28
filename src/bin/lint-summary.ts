#!/usr/bin/env node
import { parseArgs } from "node:util";

import { runCli } from "../guardrails/cli.ts";
import { repositoryRoot } from "../guardrails/files.ts";
import { lintSummary } from "../guardrails/oxlint.ts";

runCli(() => {
  const { positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
  });
  const summary = lintSummary(repositoryRoot(), positionals);
  for (const line of summary.lines) process.stdout.write(`${line}\n`);
  return summary.failed ? 1 : 0;
});
