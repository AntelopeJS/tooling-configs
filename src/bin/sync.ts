#!/usr/bin/env node
import { parseArgs } from "node:util";

import { runCli } from "../guardrails/cli.ts";
import { CI_CONTEXT, CI_PATH } from "../guardrails/ci-workflow.ts";
import { repositoryRoot } from "../guardrails/files.ts";
import { ENABLE_BRANCH_CLEANUP, initRepository } from "../guardrails/init.ts";
import {
  moveDependencyRanges,
  type RangeMoves,
} from "../guardrails/dependency-ranges-sync.ts";
import { syncRepository } from "../guardrails/sync.ts";
import {
  isVerifyChoice,
  type VerifyChoice,
} from "../guardrails/verify-skill.ts";

type SyncResult = ReturnType<typeof syncRepository>;

/** The sync result with the interface range moves that ran before it, or the moves alone when relocking them failed. */
function withRangeMoves(
  ranges: RangeMoves,
  result: SyncResult | undefined,
): SyncResult {
  if (!result)
    return {
      artifacts: [],
      paths: [],
      removed: [],
      errors: ranges.errors,
      notes: ranges.notes,
      verifyNotes: [],
      advisories: [],
      dependenciesAdded: false,
    };
  return {
    ...result,
    paths: result.errors.length
      ? []
      : [...new Set([...ranges.paths, ...result.paths])],
    notes: [...ranges.notes, ...result.notes],
  };
}

function printSync(
  result: SyncResult,
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
  const reportedBySync =
    result.sync && !result.sync.errors.length ? result.sync.paths : [];
  for (const path of result.paths)
    if (!reportedBySync.includes(path))
      process.stdout.write(`Updated: ${path}\n`);
  for (const path of result.removed) process.stdout.write(`Removed: ${path}\n`);
  const synced = result.sync
    ? printSync(result.sync, { check: false, installed: true })
    : 0;
  if (result.untypedDocs.length)
    process.stdout.write(
      `Note: ${result.untypedDocs.join(", ")} hold TypeScript fences or docs-api pages the docs check typechecks. Set docs-typescript-project in ${CI_PATH} to a tsconfig whose program resolves their imports, or mark illustrative fences \`fragment\`. Without it the check uses the root tsconfig.json and fails when there is none.\n`,
    );
  if (result.failure !== undefined) process.stderr.write(`${result.failure}\n`);
  const failed = synced !== 0 || result.failure !== undefined;
  if (failed)
    process.stderr.write(
      "Fix the errors above, then rerun antelopejs-sync --init.\n",
    );
  else
    process.stdout.write(
      `Commit and push to the default branch so ${CI_CONTEXT} is reported.\n`,
    );
  const cleanup = result.branchCleanup;
  if (cleanup.kind === "enabled")
    process.stdout.write("Updated: delete_branch_on_merge on GitHub\n");
  if (cleanup.kind === "unavailable")
    process.stderr.write(
      `delete_branch_on_merge is not on (${cleanup.reason}). Run: ${ENABLE_BRANCH_CLEANUP}\n`,
    );
  return failed || cleanup.kind === "unavailable" ? 1 : 0;
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
  const root = repositoryRoot();
  const check = Boolean(values.check);
  const ranges = moveDependencyRanges(root, check);
  const result = ranges.errors.length
    ? undefined
    : syncRepository(root, {
        check,
        profile: values.profile,
        verify: values.verify,
      });
  return printSync(withRangeMoves(ranges, result), {
    check,
    installed: false,
  });
});
