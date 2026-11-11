#!/usr/bin/env node
import { parseArgs } from "node:util";

import { runCli } from "../guardrails/cli.ts";
import { CI_CONTEXT } from "../guardrails/ci-workflow.ts";
import { repositoryRoot } from "../guardrails/files.ts";
import { ENABLE_BRANCH_CLEANUP, initRepository } from "../guardrails/init.ts";
import { syncRepository } from "../guardrails/sync.ts";
import {
  isVerifyChoice,
  type VerifyChoice,
} from "../guardrails/verify-skill.ts";

function printSync(
  result: ReturnType<typeof syncRepository>,
  { check, installed }: { check: boolean; installed: boolean },
): number {
  for (const note of result.notes)
    process.stdout.write(
      `Note: ${check || result.errors.length ? "Planned migration. " : ""}${note}\n`,
    );
  for (const note of result.verifyNotes)
    process.stdout.write(`Note: ${note}\n`);
  for (const advisory of result.advisories)
    process.stdout.write(`${advisory}\n`);
  for (const error of result.errors) process.stderr.write(`${error}\n`);
  if (result.errors.length) return 1;
  for (const path of result.paths)
    process.stdout.write(
      check
        ? `Drift: ${path}; run antelopejs-sync\n`
        : `${result.removed.includes(path) ? "Removed" : "Updated"}: ${path}\n`,
    );
  if (!result.paths.length) process.stdout.write("Guardrails are in sync.\n");
  if (!check && !installed && result.dependenciesAdded)
    process.stdout.write(
      "Added devDependencies. Run install with your package manager before using the hooks or checks.\n",
    );
  return check && result.paths.length ? 1 : 0;
}

function init(verify: VerifyChoice | undefined): number {
  const result = initRepository(repositoryRoot(), { verify });
  for (const path of result.paths) process.stdout.write(`Updated: ${path}\n`);
  const synced = result.sync
    ? printSync(result.sync, { check: false, installed: true })
    : 0;
  if (result.installFailure !== undefined) {
    process.stderr.write(`${result.installFailure}\n`);
    return 1;
  }
  if (synced) return synced;
  process.stdout.write(
    `Commit and push to the default branch so ${CI_CONTEXT} is reported.\n`,
  );
  const cleanup = result.branchCleanup;
  if (cleanup?.kind === "enabled")
    process.stdout.write("Updated: delete_branch_on_merge on GitHub\n");
  if (cleanup?.kind !== "unavailable") return 0;
  process.stderr.write(
    `delete_branch_on_merge is not on (${cleanup.reason}). Run: ${ENABLE_BRANCH_CLEANUP}\n`,
  );
  return 1;
}

runCli(() => {
  const { values } = parseArgs({
    options: {
      check: { type: "boolean" },
      init: { type: "boolean" },
      profile: { type: "string", default: "full" },
      verify: { type: "string" },
    },
  });
  if (values.profile !== "full" && values.profile !== "template")
    throw new Error("--profile must be full or template.");
  if (values.verify !== undefined && !isVerifyChoice(values.verify))
    throw new Error("--verify must be interface, module, template, or custom.");
  if (values.init && (values.check || values.profile === "template"))
    throw new Error(
      "--init sets up a full-profile repository; it cannot be combined with --check or --profile template.",
    );
  if (values.init) return init(values.verify);
  return printSync(
    syncRepository(repositoryRoot(), {
      check: values.check,
      profile: values.profile,
      verify: values.verify,
    }),
    { check: Boolean(values.check), installed: false },
  );
});
