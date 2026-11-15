#!/usr/bin/env node
import { parseArgs } from "node:util";

import { apiDiff } from "../guardrails/api-diff.ts";
import { runCli } from "../guardrails/cli.ts";
import { repositoryRoot } from "../guardrails/files.ts";

const USAGE = "Usage: antelopejs-api-diff <base-ref> [--allow-added <glob>]...";

function parse(args: string[]) {
  try {
    const { positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        "allow-added": { type: "string", multiple: true },
      },
    });
    if (positionals.length !== 1) throw new Error(USAGE);
    return { baseRef: positionals[0], ...values };
  } catch {
    throw new Error(USAGE);
  }
}

runCli(() => {
  const { baseRef, "allow-added": allowAdded } = parse(process.argv.slice(2));
  const result = apiDiff(repositoryRoot(), baseRef, allowAdded);
  process.stdout.write(result.output);
  return result.different ? 1 : 0;
});
