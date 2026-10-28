#!/usr/bin/env node
import { parseArgs } from "node:util";

import { runCli } from "../guardrails/cli.ts";
import { repositoryRoot } from "../guardrails/files.ts";
import {
  raisedCeilings,
  suppressionBase,
} from "../guardrails/suppression-base.ts";
import {
  checkSuppressions,
  stagedSuppressions,
} from "../guardrails/suppression-budget.ts";
import { checkPolicy } from "../guardrails/suppression-policy.ts";

function fullCheck(root: string, update?: boolean, base?: string): string[] {
  const failures = checkSuppressions(root, update);
  const revision = suppressionBase(root, base);
  return revision === undefined
    ? [...failures, ...checkPolicy(root)]
    : [
        ...raisedCeilings(root, revision),
        ...failures,
        ...checkPolicy(root, revision),
      ];
}

runCli(() => {
  const { values } = parseArgs({
    options: {
      update: { type: "boolean" },
      staged: { type: "boolean" },
      base: { type: "string" },
    },
    allowPositionals: true,
  });
  if (values.staged && (values.update || values.base !== undefined))
    throw new Error("--staged cannot be combined with --update or --base.");
  const root = repositoryRoot();
  const failures = values.staged
    ? stagedSuppressions(root)
    : fullCheck(root, values.update, values.base);
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  return failures.length ? 1 : 0;
});
