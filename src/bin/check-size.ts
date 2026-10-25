#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { runCli } from "../guardrails/cli.ts";
import { repositoryPath, repositoryRoot } from "../guardrails/files.ts";
import { checkSize } from "../guardrails/size.ts";

runCli(() => {
  const root = repositoryRoot();
  const { values, positionals } = parseArgs({
    options: { staged: { type: "boolean" } },
    allowPositionals: true,
  });
  const files = positionals.length
    ? positionals.map((file) => repositoryPath(root, resolve(file)))
    : undefined;
  const failures = checkSize(root, files, values.staged);
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  return failures.length ? 1 : 0;
});
