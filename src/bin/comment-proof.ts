#!/usr/bin/env node
import { runCli } from "../guardrails/cli.ts";
import { commentProof } from "../guardrails/comment-proof.ts";
import { repositoryRoot } from "../guardrails/files.ts";

runCli(() => {
  const args = process.argv.slice(2);
  if (args.length !== 1)
    throw new Error("Usage: antelopejs-comment-proof <base-ref>");
  const result = commentProof(repositoryRoot(), args[0]);
  process.stdout.write(result.output);
  return result.different ? 1 : 0;
});
