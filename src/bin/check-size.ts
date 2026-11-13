#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { runCli } from "../guardrails/cli.ts";
import { repositoryPath, repositoryRoot } from "../guardrails/files.ts";
import { checkBlanketDisables } from "../guardrails/directives.ts";
import { checkSize } from "../guardrails/size.ts";

runCli(() => {
  const root = repositoryRoot();
  const { values, positionals } = parseArgs({
    options: { staged: { type: "boolean" } },
    allowPositionals: true,
  });
  const cwd = realpathSync.native(process.cwd());
  const files = positionals.length
    ? positionals.map((file) => repositoryPath(root, resolve(cwd, file)))
    : undefined;
  const failures = [
    ...checkSize(root, files, values.staged),
    ...checkBlanketDisables(root, files, values.staged),
  ];
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  return failures.length ? 1 : 0;
});
