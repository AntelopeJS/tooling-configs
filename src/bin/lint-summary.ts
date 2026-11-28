#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { runCli } from "../guardrails/cli.ts";
import { repositoryPath, repositoryRoot } from "../guardrails/files.ts";
import { lintSummary } from "../guardrails/oxlint.ts";

runCli(() => {
  const { positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
  });
  const root = repositoryRoot();
  const cwd = realpathSync.native(process.cwd());
  const files = positionals.map((path) => {
    const absolute = resolve(cwd, path);
    if (!existsSync(absolute)) throw new Error(`${path} does not exist.`);
    return repositoryPath(root, absolute);
  });
  const summary = lintSummary(root, files);
  for (const line of summary.lines) process.stdout.write(`${line}\n`);
  return summary.failed ? 1 : 0;
});
