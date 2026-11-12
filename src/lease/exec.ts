import {
  accessSync,
  closeSync,
  constants,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { delimiter, join, win32 } from "node:path";

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

/** A program Windows starts: itself, or a `.bat` or `.cmd` file under `cmd.exe`. */
interface WindowsStart {
  readonly kind: "start";
  readonly file: string;
  readonly script: boolean;
}

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const WINDOWS_PROGRAMS = new Set([".com", ".exe"]);
const WINDOWS_SCRIPTS = new Set([".bat", ".cmd"]);
const WINDOWS_PATH_SEPARATOR = ";";
const WINDOWS_DRIVE_OR_DIRECTORY = /^[A-Za-z]:|[\\/]/u;
const UNQUOTABLE_FOR_CMD = /["%\r\n]/u;
const WINDOWS_STARTABLE = "a .exe, .com, .bat or .cmd file";
const CONSOLE_SIGNALS: readonly NodeJS.Signals[] = [
  "SIGINT",
  "SIGBREAK",
  "SIGHUP",
];

function isStartable(extension: string): boolean {
  return WINDOWS_PROGRAMS.has(extension) || WINDOWS_SCRIPTS.has(extension);
}

/** The value of the variable `name` however `env` spells its case, as Windows reads it. */
function windowsVariable(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const key = Object.keys(env).find((each) => each.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The files `base` may name: itself when it ends in a startable extension, else it plus each `PATHEXT` one. */
function withExtensions(base: string, extensions: readonly string[]): string[] {
  return isStartable(win32.extname(base).toLowerCase())
    ? [base]
    : extensions.map((extension) => base + extension);
}

/**
 * The program `name` names on Windows, found the way `cmd.exe` finds it: as a path when it holds a
 * drive or a directory, else in each directory of `Path` in `env` in turn, trying each `PATHEXT`
 * extension a name without one needs. Only `.exe`, `.com`, `.bat` and `.cmd` start; any other
 * extension in `PATHEXT` is ignored, and a file with one is refused with 126.
 */
export function locateWindows(
  name: string,
  env: NodeJS.ProcessEnv,
  isFile: (path: string) => boolean = isRegularFile,
): WindowsStart | Refusal {
  if (name === "") return NOT_FOUND;
  const extensions = (windowsVariable(env, "PATHEXT") ?? DEFAULT_PATHEXT)
    .split(WINDOWS_PATH_SEPARATOR)
    .map((extension) => extension.trim().toLowerCase())
    .filter(isStartable);
  const bases = WINDOWS_DRIVE_OR_DIRECTORY.test(name)
    ? [name]
    : (windowsVariable(env, "PATH") ?? "")
        .split(WINDOWS_PATH_SEPARATOR)
        .map((directory) => directory.trim().replaceAll('"', ""))
        .filter(Boolean)
        .map((directory) => win32.join(directory, name));
  for (const base of bases)
    for (const file of withExtensions(base, extensions))
      if (isFile(file))
        return {
          kind: "start",
          file,
          script: WINDOWS_SCRIPTS.has(win32.extname(file).toLowerCase()),
        };
  const plain = bases.find(isFile);
  return plain === undefined
    ? NOT_FOUND
    : refusal(126, `${plain} is not ${WINDOWS_STARTABLE}`);
}

function quoteForCmd(word: string): string {
  return `"${word.replace(/(\\+)$/u, "$1$1")}"`;
}

/** The `cmd.exe` command line that runs the script `file` with `args`, or why none can carry them unchanged. */
function cmdLine(
  file: string,
  args: readonly string[],
): { readonly kind: "line"; readonly line: string } | Refusal {
  const words = [file, ...args];
  return words.some((word) => UNQUOTABLE_FOR_CMD.test(word))
    ? refusal(
        126,
        `${file} runs under cmd.exe, which cannot pass a double quote, a percent sign or a line break in a path or argument unchanged`,
      )
    : { kind: "line", line: `"${words.map(quoteForCmd).join(" ")}"` };
}

function waitFor(
  name: string,
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  verbatim: boolean,
): Promise<number> {
  for (const signal of CONSOLE_SIGNALS) process.on(signal, () => undefined);
  return new Promise((resolve) => {
    const started = spawn(file, args, {
      env,
      stdio: "inherit",
      windowsVerbatimArguments: verbatim,
    });
    started.once("error", (error: NodeJS.ErrnoException) => {
      process.stderr.write(
        `antelopejs-lease: cannot run ${name}: ${error.message}\n`,
      );
      resolve(error.code === "ENOENT" ? 127 : 126);
    });
    started.once("exit", (code) => resolve(code ?? 1));
  });
}

/**
 * Runs `command` as a child on Windows, which has no `execve`, and answers its exit code. The
 * child shares this console, so Ctrl+C and Ctrl+Break reach it directly; this process ignores
 * them and outlives it by only the time to pass its code on.
 */
async function launchWindows(
  command: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const [name = "", ...args] = command;
  const verdict = locateWindows(name, env);
  if (verdict.kind === "refuse") return report(name, verdict);
  if (!verdict.script) return waitFor(name, verdict.file, args, env, false);
  const built = cmdLine(verdict.file, args);
  if (built.kind === "refuse") return report(name, built);
  return waitFor(
    name,
    windowsVariable(env, "COMSPEC") ?? "cmd.exe",
    ["/d", "/s", "/c", built.line],
    env,
    true,
  );
}

function report(name: string, verdict: Refusal): number {
  process.stderr.write(
    `antelopejs-lease: cannot run ${name}: ${verdict.reason}\n`,
  );
  return verdict.code;
}

function replaceWith(
  command: readonly string[],
  env: NodeJS.ProcessEnv,
): number {
  if (process.execve === undefined)
    throw new Error(
      "antelopejs-lease: run needs process.execve, from Node 22.15 on Linux or macOS",
    );
  const [name = "", ...args] = command;
  const verdict = locate(name, env);
  if (verdict.kind === "refuse") return report(name, verdict);
  for (const signal of IGNORED_BY_NODE) process.on(signal, () => undefined);
  return verdict.viaShell
    ? process.execve(SHELL, [SHELL, verdict.file, ...args], env)
    : process.execve(verdict.file, [name, ...args], env);
}

/**
 * Runs `command` under exactly `env` and answers its exit code. On Linux and macOS it replaces
 * this process: the command keeps this pid and is the only process, so a signal from a terminal, a
 * process-group kill or `kill <pid>` reaches it once, and its exit status, 128 plus the signal
 * included, is the caller's. Node ignores SIGPIPE and SIGXFSZ, and an ignored signal stays ignored
 * across `execve`, so both get a handler first, which `execve` resets to the default. That path
 * returns only when the command cannot start. On Windows, which has no `execve`, the command runs
 * as a child of this process, found through `Path` and `PATHEXT`. Either way a command that
 * cannot start prints why and answers 127 when it is not found and 126 when it is found but cannot
 * run, as a shell exits.
 */
export function launch(
  command: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return process.platform === "win32"
    ? launchWindows(command, env)
    : Promise.resolve(replaceWith(command, env));
}
