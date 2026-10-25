#!/usr/bin/env node
import { resolve } from "node:path";

import { runCli } from "../guardrails/cli.ts";
import { repositoryPath, repositoryRoot } from "../guardrails/files.ts";
import { checkSize } from "../guardrails/size.ts";

runCli(() => {
  const root = repositoryRoot();
  const args = process.argv.slice(2);
  const files = args.length
    ? args.map((file) => repositoryPath(root, resolve(file)))
    : undefined;
  const failures = checkSize(root, files);
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  return failures.length ? 1 : 0;
});
