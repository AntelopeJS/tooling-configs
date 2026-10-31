#!/usr/bin/env node
import { runCliAsync } from "../guardrails/cli.ts";
import { parseCaptureArgs } from "../capture/demo.ts";
import { capture } from "../capture/run.ts";
import { repositoryRoot } from "../guardrails/files.ts";

void runCliAsync(async () => {
  const failures = await capture(
    repositoryRoot(),
    parseCaptureArgs(process.argv.slice(2)),
  );
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  return failures.length ? 1 : 0;
});
