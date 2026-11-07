import { posix } from "node:path";

export const ROOT_PROGRAM = "tsconfig.json";

/** What one `tsc` command line checks. */
export interface TscRun {
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

export function tscRun(args: readonly string[]): TscRun {
  const build = ["b", "build"].includes(optionName(args[0] ?? "") ?? "");
  const positional: string[] = [];
  let project: string | undefined;
  let skipsLibCheck = false;
  for (let index = build ? 1 : 0; index < args.length; index++) {
    const option = optionName(args[index]);
    if (option === "p" || option === "project") project = args[++index];
    else if (option === "skiplibcheck")
      skipsLibCheck = args[index + 1] !== "false";
    else if (option === undefined) positional.push(args[index]);
  }
  const named = build ? positional : project === undefined ? [] : [project];
  return {
    programs: (named.length === 0 ? ["."] : named).map(normalizeProgram),
    build,
    skipsLibCheck,
  };
}
