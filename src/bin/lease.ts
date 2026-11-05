#!/usr/bin/env node
import { parseArgs } from "node:util";

import { runCliAsync } from "../guardrails/cli.ts";
import { run, status, statusTable } from "../lease/commands.ts";
import { isServerRole } from "../lease/env.ts";

const USAGE =
  "usage: antelopejs-lease run [--as api|web] -- <command...> | status [--json]";

function usage(problem: string): Error {
  return new Error(`antelopejs-lease: ${problem}\n${USAGE}`);
}

async function runVerb(args: string[], command: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { as: { type: "string" } } });
  if (values.as !== undefined && !isServerRole(values.as))
    throw usage(`--as takes api or web, not ${values.as}`);
  if (command.length === 0) throw usage("run needs a command after --");
  return run(command, values.as, process.env);
}

async function statusVerb(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { json: { type: "boolean" } },
  });
  const rows = await status(process.env);
  process.stdout.write(
    values.json ? `${JSON.stringify(rows, null, 2)}\n` : statusTable(rows),
  );
  return 0;
}

await runCliAsync(async () => {
  const argv = process.argv.slice(2);
  const split = argv.indexOf("--");
  const [verb, ...args] = split === -1 ? argv : argv.slice(0, split);
  const command = split === -1 ? [] : argv.slice(split + 1);
  if (verb === "run") return runVerb(args, command);
  if (command.length > 0) throw usage(`${verb} takes no command`);
  if (verb === "status") return statusVerb(args);
  throw usage(
    verb === undefined ? "missing command" : `unknown command ${verb}`,
  );
});
