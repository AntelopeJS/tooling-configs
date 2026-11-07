const SEPARATORS = /&&|\|\||[;|\n]|(?<![>&])&(?!&)/u;
const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=/u;
const TSC_COMMAND = /(?:^|[\\/])tsc(?:\.js)?$/u;
const MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
const NPM_BUILTINS = new Set(["test", "start", "stop", "restart"]);
const WRAPPERS = new Set(["cross-env", "cross-env-shell", "env", "corepack"]);
const EXEC_RUNNERS = new Set(["npx", "bunx", "pnpx"]);
const EXEC_VERBS = new Set(["exec", "x", "dlx"]);
const RUN_ALL = new Set(["run-s", "run-p", "npm-run-all", "npm-run-all2"]);
const RUN_ALL_VALUED = new Set(["--max-parallel", "--npm-path"]);
const EXEC_VALUED = new Set(["-p", "--package", "-c", "--call"]);
const TARGET_VALUED = new Set([
  "--filter",
  "-F",
  "--dir",
  "-C",
  "--prefix",
  "--cwd",
  "--workspace",
]);
const TARGET_FLAGS = new Set(["-r", "--recursive", "--workspaces", "-ws"]);

/** One thing a command line of a script runs: scripts of the same package, or a `tsc` with its arguments. */
export type Step =
  | {
      kind: "script";
      /** Script names, or `run-s` patterns where `*` matches within a `:` segment and `**` across them. */
      names: string[];
      /** The package manager was pointed at another package (`--filter`, `-C`, `-r`), so the names are not this package's scripts. */
      elsewhere: boolean;
    }
  | { kind: "tsc"; args: string[] };

interface Options {
  index: number;
  elsewhere: boolean;
}

function words(segment: string): string[] {
  return segment
    .replace(/[()]/gu, " ")
    .split(/\s+/u)
    .map((word) => word.replace(/^["']|["']$/gu, ""))
    .filter(Boolean);
}

/** The simple commands of a script: `&&`, `||`, `;`, `|`, `&`, newlines and parentheses all end one. */
function lines(script: string): string[][] {
  return script
    .split(SEPARATORS)
    .map(words)
    .filter((list) => list.length > 0);
}

/** Skips the options from `from`, and the values of those that take one; `elsewhere` when one points at another package. */
function skipOptions(
  args: readonly string[],
  from: number,
  valued: ReadonlySet<string>,
): Options {
  let index = from;
  let elsewhere = false;
  while (index < args.length && args[index].startsWith("-")) {
    const [name, ...value] = args[index].split("=");
    elsewhere ||= TARGET_VALUED.has(name) || TARGET_FLAGS.has(name);
    index += valued.has(name) && value.length === 0 ? 2 : 1;
  }
  return { index, elsewhere };
}

function isTsc(word: string): boolean {
  return TSC_COMMAND.test(word);
}

/** `tsc`, a path to it, or `node` running one. */
function programSteps(line: readonly string[]): Step[] {
  const [head, ...rest] = line;
  if (head === undefined) return [];
  if (isTsc(head)) return [{ kind: "tsc", args: rest }];
  if (head !== "node") return [];
  if (rest[0] === "--run" && rest[1] !== undefined)
    return [{ kind: "script", names: [rest[1]], elsewhere: false }];
  const at = rest.findIndex((word) => !word.startsWith("-"));
  return at !== -1 && isTsc(rest[at])
    ? [{ kind: "tsc", args: rest.slice(at + 1) }]
    : [];
}

/** What `npx`, `pnpm exec` and `npm exec` run: the command after the options and the packages they name. */
function execSteps(args: readonly string[]): Step[] {
  return programSteps(args.slice(skipOptions(args, 0, EXEC_VALUED).index));
}

function managerSteps(manager: string, args: readonly string[]): Step[] {
  const valued = new Set(TARGET_VALUED);
  if (manager === "npm") valued.add("-w");
  const first = skipOptions(args, 0, valued);
  const verb = args[first.index];
  if (verb === undefined) return [];
  if (EXEC_VERBS.has(verb)) return execSteps(args.slice(first.index + 1));
  if (verb === "run" || verb === "run-script") {
    const second = skipOptions(args, first.index + 1, valued);
    const name = args[second.index];
    return name === undefined
      ? []
      : [
          {
            kind: "script",
            names: [name],
            elsewhere: first.elsewhere || second.elsewhere,
          },
        ];
  }
  if (isTsc(verb)) return programSteps(args.slice(first.index));
  if (manager === "npm" && !NPM_BUILTINS.has(verb)) return [];
  return [{ kind: "script", names: [verb], elsewhere: first.elsewhere }];
}

function runAllSteps(args: readonly string[]): Step[] {
  const names: string[] = [];
  for (let index = 0; index < args.length && args[index] !== "--"; index++)
    if (!args[index].startsWith("-")) names.push(args[index]);
    else if (RUN_ALL_VALUED.has(args[index])) index++;
  return names.length === 0
    ? []
    : [{ kind: "script", names, elsewhere: false }];
}

/** The line without its leading environment assignments and wrappers (`cross-env A=1`, `env`, `corepack`). */
function unwrapped(line: readonly string[]): readonly string[] {
  let index = 0;
  let wrapped = false;
  while (index < line.length) {
    const word = line[index];
    if (WRAPPERS.has(word)) wrapped = true;
    else if (!ENV_ASSIGNMENT.test(word) && !(wrapped && word.startsWith("-")))
      break;
    index++;
  }
  return line.slice(index);
}

function lineSteps(line: readonly string[]): Step[] {
  const [head, ...args] = unwrapped(line);
  if (head === undefined) return [];
  if (RUN_ALL.has(head)) return runAllSteps(args);
  if (MANAGERS.has(head)) return managerSteps(head, args);
  if (EXEC_RUNNERS.has(head)) return execSteps(args);
  return programSteps([head, ...args]);
}

/** The scripts and `tsc` runs a script's command lines start. */
export function stepsOf(script: string): Step[] {
  return lines(script).flatMap(lineSteps);
}

/** The script names a `run-s` pattern list selects among `available`. */
export function matchingScripts(
  names: readonly string[],
  available: Iterable<string>,
): string[] {
  const all = [...available];
  return names.flatMap((name) => {
    if (!name.includes("*")) return [name];
    const pattern = new RegExp(
      `^${name
        .split("**")
        .map((part) =>
          part
            .split("*")
            .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
            .join("[^:]*"),
        )
        .join(".*")}$`,
      "u",
    );
    return all.filter((script) => pattern.test(script));
  });
}
