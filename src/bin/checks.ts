#!/usr/bin/env node
import { parseArgs } from "node:util";

import { CHECKS_SKIP_ENV, runChecks } from "../guardrails/checks.ts";
import { runCliAsync } from "../guardrails/cli.ts";
import { repositoryRoot } from "../guardrails/files.ts";

const SIGNAL_EXIT = new Map<NodeJS.Signals, number>([
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
]);

runCliAsync(async () => {
  const { values } = parseArgs({
    options: { "no-services": { type: "boolean" } },
  });
  const controller = new AbortController();
  let exitCode = 1;
  for (const [name, code] of SIGNAL_EXIT)
    process.on(name, () => {
      if (controller.signal.aborted) return;
      exitCode = code;
      controller.abort(name);
    });
  const result = await runChecks(repositoryRoot(), {
    skipSetting: process.env[CHECKS_SKIP_ENV],
    services: !values["no-services"],
    signal: controller.signal,
  });
  process.stdout.write(result.output);
  if (result.interrupted) return exitCode;
  return result.failed ? 1 : 0;
});
