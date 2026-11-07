#!/usr/bin/env node
import { parseArgs } from "node:util";

import { runCliAsync } from "../guardrails/cli.ts";
import { down, gc, run, status, statusTable } from "../lease/commands.ts";
import { isServerRole } from "../lease/env.ts";

const USAGE =
  "usage: antelopejs-lease run [--as api|web] -- <command...> | status [--json] | down [--stop] [--force] | gc [--idle <days>]";
const DEFAULT_IDLE_DAYS = 14;
const MIN_IDLE_DAYS = 1;

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

async function downVerb(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { force: { type: "boolean" }, stop: { type: "boolean" } },
  });
  await down(process.env, {
    force: values.force === true,
    stop:
      values.stop === true
        ? (line) => process.stdout.write(`${line}\n`)
        : undefined,
  });
  return 0;
}

async function gcVerb(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { idle: { type: "string" } } });
  const days =
    values.idle === undefined ? DEFAULT_IDLE_DAYS : Number(values.idle);
  if (!Number.isFinite(days) || days < MIN_IDLE_DAYS)
    throw usage(
      `--idle takes ${MIN_IDLE_DAYS} or more days, not ${values.idle}; a lease a run opened within the last day is never idle`,
    );
  await gc(process.env, days);
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
  if (verb === "down") return downVerb(args);
  if (verb === "gc") return gcVerb(args);
  throw usage(
    verb === undefined ? "missing command" : `unknown command ${verb}`,
  );
});
