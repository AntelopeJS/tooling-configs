import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";

import { windowsArgument } from "../guardrails/run-command.ts";

/** A program and arguments ready for `spawn`; `verbatim` is `windowsVerbatimArguments`. */
export interface Launch {
  program: string;
  args: string[];
  verbatim: boolean;
}

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const SHIM_EXTENSIONS = new Set([".cmd", ".bat"]);

/** The value of `name` in `env`, whatever the case its key has, as Windows reads its environment. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key === undefined ? undefined : env[key];
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** The file Windows would start for `program`: the first PATH folder holding it under one of the PATHEXT extensions, or `program` itself when it names a path. */
function findProgram(program: string, env: NodeJS.ProcessEnv): string | null {
  const extensions = (envValue(env, "PATHEXT") ?? DEFAULT_PATHEXT)
    .split(";")
    .filter((extension) => extension !== "");
  const names =
    extname(program) === ""
      ? extensions.map((extension) => `${program}${extension}`)
      : [program];
  const folders =
    isAbsolute(program) || /[\\/]/.test(program)
      ? [""]
      : (envValue(env, "PATH") ?? "").split(delimiter);
  for (const folder of folders)
    for (const name of names) {
      const candidate = folder === "" ? name : join(folder, name);
      if (isFile(candidate)) return candidate;
    }
  return null;
}

/**
 * How to start `program` with `args` for `env`. Off Windows it is the call as
 * given. On Windows `pnpm`, `ajs` and every other npm shim is a `.cmd` file
 * that `spawn` can neither find by its bare name nor start without a shell, so
 * a program that resolves to one runs through `cmd.exe`, and any other
 * program is spawned directly with the arguments untouched.
 */
export function launch(
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Launch {
  if (process.platform !== "win32") return { program, args, verbatim: false };
  const found = findProgram(program, env);
  if (found === null || !SHIM_EXTENSIONS.has(extname(found).toLowerCase()))
    return { program: found ?? program, args, verbatim: false };
  const line = [found, ...args].map(windowsArgument).join(" ");
  return {
    program: envValue(env, "ComSpec") ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    verbatim: true,
  };
}

/** `spawnSync` of `program` the way `launch` starts it, so a `.cmd` shim runs on Windows. */
export function spawnLaunched(
  program: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
  const started = launch(program, args, options.env ?? process.env);
  return spawnSync(started.program, started.args, {
    ...options,
    windowsVerbatimArguments: started.verbatim,
  });
}

/** Kills the process `pid` and everything it started, since Windows has no process groups to signal; whether it found the process. */
export function killTree(pid: number): boolean {
  return (
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
    }).status === 0
  );
}
