#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { checkBody, findingsBlock } from "../guardrails/body-check.ts";
import { runCli } from "../guardrails/cli.ts";
import { repositoryRoot, resolveRevision } from "../guardrails/files.ts";

const USAGE =
  "Usage: antelopejs-body-check <body.md | -> [--head <sha>] [--base <sha>] | antelopejs-body-check --findings";

function parse(args: string[]) {
  try {
    const { positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        findings: { type: "boolean" },
        head: { type: "string" },
        base: { type: "string" },
      },
    });
    if (positionals.length !== (values.findings ? 0 : 1))
      throw new Error(USAGE);
    return { body: positionals.at(0), ...values };
  } catch {
    throw new Error(USAGE);
  }
}

runCli(() => {
  const { base, body, findings, head } = parse(process.argv.slice(2));
  const root = repositoryRoot();
  if (findings) {
    process.stdout.write(findingsBlock(root));
    return 0;
  }
  const current = resolveRevision(root, "HEAD");
  if (head !== undefined && head !== current)
    throw new Error(
      `HEAD is ${current}, not the pull request head ${head}: check out the pull request head (actions/checkout with ref: \${{ github.event.pull_request.head.sha }}) before running antelopejs-body-check.`,
    );
  const text = readFileSync(body === "-" ? 0 : (body ?? 0), "utf8");
  const problems = checkBody(root, text, { base });
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  return problems.length ? 1 : 0;
});
