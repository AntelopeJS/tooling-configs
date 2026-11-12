#!/usr/bin/env node
import { parseArgs } from "node:util";

import { runCli } from "../guardrails/cli.ts";
import { repositoryRoot } from "../guardrails/files.ts";
import { STRIP_KINDS, writeStrip } from "../guardrails/readme-strip.ts";

const USAGE = `usage: antelopejs-readme-strip --kind <${STRIP_KINDS.join("|")}> --name <repo-name>`;

runCli(() => {
  const { values } = parseArgs({
    options: { kind: { type: "string" }, name: { type: "string" } },
  });
  if (values.kind === undefined || values.name === undefined)
    throw new Error(USAGE);
  writeStrip(repositoryRoot(), values.kind, values.name);
  return 0;
});
