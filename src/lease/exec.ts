import {
  accessSync,
  closeSync,
  constants,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { delimiter, join } from "node:path";

const SHELL = "/bin/sh";
const DEFAULT_PATH = "/bin:/usr/bin";
const HEADER_BYTES = 256;
const SHEBANG = /^#![ \t]*([^ \t\n]*)/u;
const IGNORED_BY_NODE: readonly NodeJS.Signals[] = ["SIGPIPE", "SIGXFSZ"];

/** A file execve starts: itself, or under `/bin/sh` when it is text without `#!`. */
interface Start {
  readonly kind: "start";
  readonly file: string;
  readonly viaShell: boolean;
}

/** Why the command cannot start, with the exit code a shell reports for it. */
interface Refusal {
  readonly kind: "refuse";
  readonly code: 126 | 127;
  readonly reason: string;
}

function refusal(code: 126 | 127, reason: string): Refusal {
  return { kind: "refuse", code, reason };
}

const NOT_FOUND = refusal(127, "not found");

/**
 * Why execve refuses `path` before it reads the file; `undefined` when it may start it. A path this
 * user cannot stat counts as missing, as a shell's `PATH` search counts it.
 */
function problem(path: string): Refusal | undefined {
  try {
    if (statSync(path).isDirectory()) return refusal(126, "is a directory");
  } catch {
    return NOT_FOUND;
  }
  try {
    accessSync(path, constants.X_OK);
    return undefined;
  } catch {
    return refusal(126, "is not executable");
  }
}

/** The first bytes of `path` as text; `undefined` when this user may run it but not read it. */
function header(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    return buffer.toString("utf8", 0, readSync(fd, buffer));
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * What execve does with `path`; `undefined` when no file is there. A `#!` line whose interpreter
 * is missing, such as `/bin/sh\r` after a CRLF, refuses with 127. A text file without `#!` starts
 * under `/bin/sh`, as execvp starts it. Anything else starts directly.
 */
function inspect(path: string): Start | Refusal | undefined {
  const own = problem(path);
  if (own === NOT_FOUND) return undefined;
  if (own !== undefined) return refusal(own.code, `${path} ${own.reason}`);
  const head = header(path);
  const interpreter = head === undefined ? undefined : SHEBANG.exec(head)?.[1];
  if (interpreter !== undefined) {
    const broken = problem(interpreter);
    if (broken !== undefined)
      return refusal(
        broken.code,
        `interpreter ${JSON.stringify(interpreter)} ${broken.reason}`,
      );
  }
  const text = head !== undefined && !head.includes("\0");
  return {
    kind: "start",
    file: path,
    viaShell: interpreter === undefined && text,
  };
}

/**
 * The file `name` names, found the way execvp finds it: as a path when it holds a `/`, else in
 * each directory of the `PATH` in `env` in turn, an empty entry naming the working directory.
 * A match execve refuses is skipped for a later one, and reported when no later one starts.
 */
function locate(name: string, env: NodeJS.ProcessEnv): Start | Refusal {
  if (name.includes("/")) return inspect(name) ?? NOT_FOUND;
  if (name === "") return NOT_FOUND;
  let refused: Refusal | undefined;
  for (const directory of (env.PATH ?? DEFAULT_PATH).split(delimiter)) {
    const verdict = inspect(join(directory || ".", name));
    if (verdict?.kind === "start") return verdict;
    refused ??= verdict;
  }
  return refused ?? NOT_FOUND;
}

/**
 * Replaces this process with `command` under exactly `env`. The command keeps this pid and is the
 * only process, so a signal from a terminal, a process-group kill or `kill <pid>` reaches it once,
 * and its exit status, 128 plus the signal included, is the caller's. Node ignores SIGPIPE and
 * SIGXFSZ, and an ignored signal stays ignored across `execve`, so both get a handler first, which
 * `execve` resets to the default. Returns only when the command cannot start: after printing why,
 * with 127 when it is not found and 126 when it is found but cannot run, as a shell exits.
 */
export function launch(
  command: readonly string[],
  env: NodeJS.ProcessEnv,
): number {
  if (process.execve === undefined)
    throw new Error(
      "antelopejs-lease: run needs process.execve, from Node 22.15 on Linux or macOS",
    );
  const [name = "", ...args] = command;
  const verdict = locate(name, env);
  if (verdict.kind === "refuse") {
    process.stderr.write(
      `antelopejs-lease: cannot run ${name}: ${verdict.reason}\n`,
    );
    return verdict.code;
  }
  for (const signal of IGNORED_BY_NODE) process.on(signal, () => undefined);
  return verdict.viaShell
    ? process.execve(SHELL, [SHELL, verdict.file, ...args], env)
    : process.execve(verdict.file, [name, ...args], env);
}
