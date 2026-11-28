#!/usr/bin/env node
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { runCli } from "../guardrails/cli.ts";
import { repositoryRoot } from "../guardrails/files.ts";
import { lintSummary } from "../guardrails/oxlint.ts";

runCli(() => {
  const { positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
  });
  const root = repositoryRoot();
  const files = positionals.map((path) => {
    if (!existsSync(path)) throw new Error(`${path} does not exist.`);
    return relative(root, resolve(path));
  });
  const summary = lintSummary(root, files);
  for (const line of summary.lines) process.stdout.write(`${line}\n`);
  return summary.failed ? 1 : 0;
});
