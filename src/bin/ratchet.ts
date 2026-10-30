#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";

import { runCli } from "../guardrails/cli.ts";
import { CEILINGS_FILE } from "../guardrails/ceilings.ts";
import {
  repositoryPath,
  repositoryRoot,
  resolveRevision,
} from "../guardrails/files.ts";
import { ratchet } from "../guardrails/ratchet.ts";
import { suppressionBase } from "../guardrails/suppression-base.ts";
import { stagedRatchet } from "../guardrails/staged-ratchet.ts";

runCli(() => {
  const { values, positionals } = parseArgs({
    options: {
      update: { type: "boolean" },
      staged: { type: "boolean" },
      base: { type: "string" },
    },
    allowPositionals: true,
  });
  const root = repositoryRoot();
  if (values.base !== undefined && values.staged)
    throw new Error("--base cannot be combined with --staged.");
  if (values.update && values.staged)
    throw new Error("--staged cannot be combined with --update.");
  if (positionals.length && !values.staged)
    throw new Error("File arguments require --staged.");
  const result = values.staged
    ? {
        failures: stagedRatchet(
          root,
          positionals.length
            ? positionals.map((file) => repositoryPath(root, resolve(file)))
            : undefined,
        ),
        lowered: [],
        adoptions: [],
        retired: false,
        created: false,
      }
    : ratchet(
        root,
        values.update,
        values.base === undefined
          ? undefined
          : resolveRevision(root, values.base),
        suppressionBase(root, values.base),
      );
  if (result.created)
    process.stdout.write(
      `Created ${CEILINGS_FILE} for the rules the pack newly enabled. Run antelopejs-sync.\n`,
    );
  for (const message of result.adoptions)
    process.stdout.write(`Adopted ${message}\n`);
  if (result.retired)
    process.stdout.write(
      `Deleted ${CEILINGS_FILE}: no debt left. Run antelopejs-sync.\n`,
    );
  for (const message of result.lowered)
    process.stdout.write(`Lowered ${message}\n`);
  for (const message of result.failures) process.stderr.write(`${message}\n`);
  if (!result.failures.length)
    process.stdout.write("Ratchet: within ceilings.\n");
  return result.failures.length ? 1 : 0;
});
