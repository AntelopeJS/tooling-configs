#!/usr/bin/env node
import { parseArgs } from "node:util";

import { runCli } from "../guardrails/cli.ts";
import { repositoryRoot } from "../guardrails/files.ts";
import {
  checkSuppressions,
  stagedSuppressions,
} from "../guardrails/suppression-budget.ts";

runCli(() => {
  const { values } = parseArgs({
    options: {
      update: { type: "boolean" },
      staged: { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (values.update && values.staged)
    throw new Error("--staged cannot be combined with --update.");
  const root = repositoryRoot();
  const failures = values.staged
    ? stagedSuppressions(root)
    : checkSuppressions(root, values.update);
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  return failures.length ? 1 : 0;
});
