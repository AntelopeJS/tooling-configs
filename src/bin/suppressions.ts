#!/usr/bin/env node
import { parseArgs } from "node:util";

import {
  deadDirectiveReport,
  touchedFiles,
} from "../guardrails/dead-directives.ts";
import { runCli } from "../guardrails/cli.ts";
import { repositoryRoot } from "../guardrails/files.ts";
import {
  raisedCeilings,
  suppressionBase,
} from "../guardrails/suppression-base.ts";
import {
  checkSuppressions,
  stagedNames,
  stagedSuppressions,
} from "../guardrails/suppression-budget.ts";

function fullCheck(root: string, update?: boolean, base?: string) {
  const failures = checkSuppressions(root, update);
  const revision = suppressionBase(root, base);
  const dead = deadDirectiveReport(root, touchedFiles(root, revision));
  const raised = revision === undefined ? [] : raisedCeilings(root, revision);
  return {
    failures: [...raised, ...failures, ...dead.failures],
    notes: dead.notes,
  };
}

function stagedCheck(root: string) {
  const dead = deadDirectiveReport(root, stagedNames(root, "ACMR"));
  return {
    failures: [...stagedSuppressions(root), ...dead.failures],
    notes: dead.notes,
  };
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
  const { failures, notes } = values.staged
    ? stagedCheck(root)
    : fullCheck(root, values.update, values.base);
  for (const note of notes) process.stdout.write(`${note}\n`);
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  return failures.length ? 1 : 0;
});
