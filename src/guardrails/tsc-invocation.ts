import { posix } from "node:path";

import type { TscCommand } from "./script-steps.ts";

export const ROOT_PROGRAM = "tsconfig.json";

/** What one `tsc` command line checks. */
export interface TscRun {
  command: TscCommand;
  /** The tsconfig files it names: `-p`, or the positional projects of `-b`, `tsconfig.json` when none. */
  programs: string[];
  /** `-b`: the projects named and the ones they reference are built. */
  build: boolean;
  skipsLibCheck: boolean;
}

function normalizeProgram(project: string): string {
  const path = posix.normalize(project.replaceAll("\\", "/"));
  return path.endsWith(".json") || path.endsWith(".jsonc")
    ? path
    : posix.join(path, ROOT_PROGRAM);
}

/** tsc reads an option name in any letter case, `-b` and `--build` included. */
function optionName(word: string): string | undefined {
  return word.startsWith("-")
    ? word.replace(/^--?/u, "").toLowerCase()
    : undefined;
}

/** The options `tsc -b` accepts that take a string as the next word, which would otherwise read as a project; TypeScript 7 adds `builders`, `checkers` and `pprofdir`. */
const VALUED = new Set([
  "builders",
  "checkers",
  "pprofdir",
  "locale",
  "generatetrace",
  "generatecpuprofile",
]);

/** The explicit values a boolean option such as `--pretty false` takes, which are not projects. */
const BOOLEAN_VALUES = new Set(["true", "false"]);

export function tscRun(command: TscCommand, args: readonly string[]): TscRun {
  const build = ["b", "build"].includes(optionName(args[0] ?? "") ?? "");
  const positional: string[] = [];
  let project: string | undefined;
  let skipsLibCheck = false;
  for (let index = build ? 1 : 0; index < args.length; index++) {
    const option = optionName(args[index]);
    if (option === "p" || option === "project") project = args[++index];
    else if (option !== undefined && VALUED.has(option)) index++;
    else if (option === "skiplibcheck")
      skipsLibCheck = args[index + 1] !== "false";
    else if (option === undefined && !BOOLEAN_VALUES.has(args[index]))
      positional.push(args[index]);
  }
  const named = build ? positional : project === undefined ? [] : [project];
  return {
    command,
    programs: (named.length === 0 ? ["."] : named).map(normalizeProgram),
    build,
    skipsLibCheck,
  };
}
