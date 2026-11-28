const SEPARATORS = /&&|\|\||[;|\n]|(?<![>&])&(?!&)/u;
const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=/u;
/** The compilers a script runs by name: TypeScript's `tsc`, and the pack's `antelopejs-tsc` and Vue's `vue-tsc`, which take the same arguments. */
const TSC_COMMANDS = ["tsc", "antelopejs-tsc", "vue-tsc"] as const;

/** A command that runs a compiler of {@link TSC_COMMANDS}. */
export type TscCommand = (typeof TSC_COMMANDS)[number];
const MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
const NPM_BUILTINS = new Set(["test", "start", "stop", "restart"]);
const WRAPPERS = new Set(["cross-env", "cross-env-shell", "env", "corepack"]);
const EXEC_RUNNERS = new Set(["npx", "bunx", "pnpx"]);
const EXEC_VERBS = new Set(["exec", "x", "dlx"]);
const RUN_ALL = new Set(["run-s", "run-p", "npm-run-all", "npm-run-all2"]);
const RUN_ALL_VALUED = new Set(["--max-parallel", "--npm-path"]);
const EXEC_VALUED = new Set(["-p", "--package", "-c", "--call"]);
const DIR_OPTIONS = new Set(["--dir", "-C", "--prefix", "--cwd"]);
const SELECT_OPTIONS = new Set([
  "--filter",
  "-F",
  "--filter-prod",
  "--workspace",
]);
/** Manager options that take their value as the next word and point at no package. */
const OTHER_VALUED = [
  "--workspace-concurrency",
  "--reporter",
  "--loglevel",
  "--test-pattern",
  "--changed-files-ignore-pattern",
  "--resume-from",
];
const MANAGER_VALUED = new Set([
  ...DIR_OPTIONS,
  ...SELECT_OPTIONS,
  ...OTHER_VALUED,
]);
const TARGET_FLAGS = new Set(["-r", "--recursive", "--workspaces", "-ws"]);

/**
 * A package a manager option points a command at, instead of the package the script belongs to.
 * `dir` is the package in the directory `--dir`, `-C`, `--prefix` or `--cwd` names, relative to where the command runs.
 * `select` is the workspace packages a name or path selector matches, from `--filter`, `-F`, `--workspace` or npm's `-w`.
 * `all` is every workspace package, from `-r`, `--recursive` or `--workspaces`.
 */
export type Target =
  | { kind: "dir"; path: string }
  | { kind: "select"; selector: string }
  | { kind: "all" };

/** One thing a command line of a script runs: scripts, a `tsc` or a mocha runner with its arguments, or a `cd` that moves the lines after it. */
export type Step =
  | {
      kind: "script";
      /** Script names, or `run-s` patterns where `*` matches within a `:` segment and `**` across them. */
      names: string[];
      /** The packages the manager was pointed at (`--filter`, `-C`, `-r`); when any, the names are not this package's scripts. */
      targets: Target[];
    }
  | {
      kind: "tsc";
      command: TscCommand;
      args: string[];
      /** The packages the manager runs it in (`pnpm --filter a exec tsc`, `pnpm -C a tsc`); none for this package. */
      targets: Target[];
    }
  | {
      kind: "test";
      runner: TestRunner;
      args: string[];
      /** The packages the manager runs it in; none for this package. */
      targets: Target[];
    }
  | { kind: "cd"; path: string };

/** The mocha runners a script starts: `ajs module test`, and `mocha` by name or path. */
type TestRunner = "ajs module test" | "mocha";

interface Options {
  index: number;
  targets: Target[];
}

/** The package an option points at; npm's `-w` selects only where `valued` lists it, since pnpm's `-w` is the workspace root. */
function target(
  name: string,
  value: string | undefined,
  valued: ReadonlySet<string>,
): Target | undefined {
  if (TARGET_FLAGS.has(name)) return { kind: "all" };
  if (value === undefined) return undefined;
  if (DIR_OPTIONS.has(name)) return { kind: "dir", path: value };
  if (SELECT_OPTIONS.has(name) || (name === "-w" && valued.has(name)))
    return { kind: "select", selector: value };
  return undefined;
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

/** Skips the options from `from`, and the values of those that take one; `targets` are the packages they point at. */
function skipOptions(
  args: readonly string[],
  from: number,
  valued: ReadonlySet<string>,
): Options {
  let index = from;
  const targets: Target[] = [];
  while (index < args.length && args[index].startsWith("-")) {
    const [name, ...inline] = args[index].split("=");
    const separate = valued.has(name) && inline.length === 0;
    const pointed = target(
      name,
      separate ? args[index + 1] : inline.length ? inline.join("=") : undefined,
      valued,
    );
    if (pointed) targets.push(pointed);
    index += separate ? 2 : 1;
  }
  return { index, targets };
}

/** The compiler `word` runs: its name or a path to it, with or without a script extension (`.js`, `.mjs`, `.cjs`, `.ts`). */
function tscCommand(word: string): TscCommand | undefined {
  const name = word
    .split(/[\\/]/u)
    .at(-1)
    ?.replace(/\.(?:[cm]?js|ts)$/u, "");
  return TSC_COMMANDS.find((command) => command === name);
}

/** The coverage tools that run a test command given after their own options. */
const COVERAGE_WRAPPERS = new Set(["c8", "nyc"]);

/** A mocha runner of {@link TestRunner} by name or path (`mocha`, `_mocha`, `mocha.js`), or one behind a coverage wrapper. */
function testSteps(line: readonly string[]): Step[] {
  const [head, ...rest] = line;
  const name = head?.split(/[\\/]/u).at(-1)?.replace(/\.js$/u, "");
  if (name === "ajs" && rest[0] === "module" && rest[1] === "test")
    return [
      {
        kind: "test",
        runner: "ajs module test",
        args: rest.slice(2),
        targets: [],
      },
    ];
  if (name === "mocha" || name === "_mocha")
    return [{ kind: "test", runner: "mocha", args: rest, targets: [] }];
  if (name === undefined || !COVERAGE_WRAPPERS.has(name)) return [];
  for (let index = 0; index < rest.length; index++) {
    const wrapped = testSteps(rest.slice(index));
    if (wrapped.length) return wrapped;
  }
  return [];
}

/** `tsc` or the pack's `antelopejs-tsc`, a path to either, a mocha runner of {@link testSteps}, or `node` running one of them. */
function programSteps(line: readonly string[]): Step[] {
  const [head, ...rest] = line;
  if (head === undefined) return [];
  const command = tscCommand(head);
  if (command) return [{ kind: "tsc", command, args: rest, targets: [] }];
  const test = testSteps(line);
  if (test.length) return test;
  if (head !== "node") return [];
  if (rest[0] === "--run" && rest[1] !== undefined)
    return [{ kind: "script", names: [rest[1]], targets: [] }];
  const at = rest.findIndex((word) => !word.startsWith("-"));
  if (at === -1) return [];
  const run = tscCommand(rest[at]);
  return run
    ? [{ kind: "tsc", command: run, args: rest.slice(at + 1), targets: [] }]
    : testSteps(rest.slice(at));
}

/** What `npx`, `pnpm exec` and `npm exec` run: the command after the options and the packages they name. */
function execSteps(args: readonly string[]): Step[] {
  return programSteps(args.slice(skipOptions(args, 0, EXEC_VALUED).index));
}

/** The steps with `targets` added, for a command the manager runs in other packages. */
function pointedAt(steps: Step[], targets: readonly Target[]): Step[] {
  return steps.map((step) =>
    step.kind === "cd"
      ? step
      : { ...step, targets: [...targets, ...step.targets] },
  );
}

/** The packages npm options after the script name point at, up to `--`: npm reads its options anywhere on the line. */
function trailingTargets(
  args: readonly string[],
  from: number,
  valued: ReadonlySet<string>,
): Target[] {
  const targets: Target[] = [];
  for (let index = from; index < args.length && args[index] !== "--"; index++)
    if (args[index].startsWith("-")) {
      const found = skipOptions(args, index, valued);
      targets.push(...found.targets);
      index = found.index - 1;
    }
  return targets;
}

function managerSteps(manager: string, args: readonly string[]): Step[] {
  const valued = new Set(MANAGER_VALUED);
  if (manager === "npm") valued.add("-w");
  const first = skipOptions(args, 0, valued);
  const verb = args[first.index];
  if (verb === undefined) return [];
  if (EXEC_VERBS.has(verb))
    return pointedAt(execSteps(args.slice(first.index + 1)), first.targets);
  if (tscCommand(verb))
    return pointedAt(programSteps(args.slice(first.index)), first.targets);
  const test = testSteps(args.slice(first.index));
  if (test.length) return pointedAt(test, first.targets);
  const run = verb === "run" || verb === "run-script";
  const second = run
    ? skipOptions(args, first.index + 1, valued)
    : { index: first.index, targets: [] };
  const name = args[second.index];
  if (
    name === undefined ||
    (!run && manager === "npm" && !NPM_BUILTINS.has(verb))
  )
    return [];
  const trailing =
    manager === "npm" ? trailingTargets(args, second.index + 1, valued) : [];
  return [
    {
      kind: "script",
      names: [name],
      targets: [...first.targets, ...second.targets, ...trailing],
    },
  ];
}

function runAllSteps(args: readonly string[]): Step[] {
  const names: string[] = [];
  for (let index = 0; index < args.length && args[index] !== "--"; index++)
    if (!args[index].startsWith("-")) names.push(args[index]);
    else if (RUN_ALL_VALUED.has(args[index])) index++;
  return names.length === 0 ? [] : [{ kind: "script", names, targets: [] }];
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
  if (head === "cd") return [{ kind: "cd", path: args[0] ?? "~" }];
  if (RUN_ALL.has(head)) return runAllSteps(args);
  if (MANAGERS.has(head)) return managerSteps(head, args);
  if (EXEC_RUNNERS.has(head)) return execSteps(args);
  return programSteps([head, ...args]);
}

/** The scripts, `tsc` runs and mocha runs a script's command lines start. */
export function stepsOf(script: string): Step[] {
  return lines(script).flatMap(lineSteps);
}

/** The script cut at its separators, which stay in the list, so joining the parts gives the script back; {@link commandSteps} reads each part. */
export function commandParts(script: string): string[] {
  return script.split(new RegExp(`(${SEPARATORS.source})`, "u"));
}

/** The steps one part of {@link commandParts} starts. */
export function commandSteps(command: string): Step[] {
  return lineSteps(words(command));
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
