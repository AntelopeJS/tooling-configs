#!/usr/bin/env node
import { parseArgs } from "node:util";

import { runCli } from "../guardrails/cli.ts";
import { repositoryRoot } from "../guardrails/files.ts";
import { syncRepository } from "../guardrails/sync.ts";

runCli(() => {
  const { values } = parseArgs({
    options: {
      check: { type: "boolean" },
      profile: { type: "string", default: "full" },
    },
  });
  if (values.profile !== "full" && values.profile !== "template")
    throw new Error("--profile must be full or template.");
  const result = syncRepository(repositoryRoot(), {
    check: values.check,
    profile: values.profile,
  });
  for (const note of result.notes)
    process.stdout.write(
      `Note: ${values.check || result.errors.length ? "Planned migration. " : ""}${note}\n`,
    );
  for (const advisory of result.advisories)
    process.stdout.write(`${advisory}\n`);
  for (const error of result.errors) process.stderr.write(`${error}\n`);
  if (result.errors.length) return 1;
  for (const path of result.paths)
    process.stdout.write(
      `${values.check ? "Drift" : "Updated"}: ${path}${values.check ? "; run antelopejs-sync" : ""}\n`,
    );
  if (!result.paths.length) process.stdout.write("Guardrails are in sync.\n");
  if (!values.check && result.dependenciesAdded)
    process.stdout.write(
      "Added devDependencies. Run install with your package manager before using the hooks or checks.\n",
    );
  return values.check && result.paths.length ? 1 : 0;
});
