import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import ts from "typescript";

import { parseManifest } from "./package.ts";

const SEPARATORS = /&&|\|\||;|\n/u;
const MAX_DEPTH = 5;
const ROOT_PROGRAM = "tsconfig.json";
const MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
const NPM_BUILTINS = new Set(["test", "start", "stop", "restart"]);
const LAUNCHERS =
  /^(?:pnpm|npm|yarn|bun|bunx|npx|exec|x|dlx|--|cross-env|[A-Za-z_]\w*=\S*|-\S*)$/u;

type Scripts = ReadonlyMap<string, string>;

interface TscRun {
  program: string;
  skipsLibCheck: boolean;
}

function words(segment: string): string[] {
  return segment
    .split(/\s+/u)
    .map((word) => word.replace(/^["']|["']$/gu, ""))
    .filter(Boolean);
}

function segments(script: string): string[][] {
  return script
    .split(SEPARATORS)
    .map(words)
    .filter((list) => list.length > 0);
}

/** The script a command line runs through a package manager: `pnpm run x`, `pnpm x`, `npm run x`, `yarn x`, `bun run x`. `npm x` only names the lifecycle scripts npm runs without `run`. */
function runsScript(
  line: readonly string[],
  scripts: Scripts,
): string | undefined {
  const start = line.findIndex((word) => !/^[A-Za-z_]\w*=/u.test(word));
  const manager = line[start];
  if (manager === undefined || !MANAGERS.has(manager)) return undefined;
  const rest = line.slice(start + 1).filter((word) => !word.startsWith("-"));
  const explicit = rest[0] === "run" || rest[0] === "run-script";
  const name = explicit ? rest[1] : rest[0];
  if (name === undefined || !scripts.has(name)) return undefined;
  return explicit || manager !== "npm" || NPM_BUILTINS.has(name)
    ? name
    : undefined;
}

/** `name` and every script it runs, to a bounded depth. */
function reachable(scripts: Scripts, name: string): string[] {
  const seen = new Set<string>();
  let frontier = [name];
  for (let depth = 0; depth <= MAX_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const current of frontier) {
      const script = scripts.get(current);
      if (script === undefined || seen.has(current)) continue;
      seen.add(current);
      for (const line of segments(script)) {
        const run = runsScript(line, scripts);
        if (run !== undefined) next.push(run);
      }
    }
    frontier = next;
  }
  return [...seen];
}

function normalizeProgram(project: string): string {
  const path = posix.normalize(project.replaceAll("\\", "/"));
  return path.endsWith(".json") ? path : posix.join(path, ROOT_PROGRAM);
}

function tscRun(line: readonly string[]): TscRun | undefined {
  const at = line.findIndex((word) => word === "tsc" || word.endsWith("/tsc"));
  if (at === -1 || !line.slice(0, at).every((word) => LAUNCHERS.test(word)))
    return undefined;
  let program = ROOT_PROGRAM;
  let skipsLibCheck = false;
  for (let index = at + 1; index < line.length; index++) {
    const word = line[index];
    if (word === "-p" || word === "--project") {
      const project = line[++index];
      if (project !== undefined) program = normalizeProgram(project);
    } else if (word === "--skipLibCheck") {
      skipsLibCheck = line[index + 1] !== "false";
    }
  }
  return { program, skipsLibCheck };
}

function ownRuns(script: string): TscRun[] {
  return segments(script).flatMap((line) => tscRun(line) ?? []);
}

function runsOf(scripts: Scripts, name: string): TscRun[] {
  return reachable(scripts, name).flatMap((script) =>
    ownRuns(scripts.get(script) ?? ""),
  );
}

function skipCoverageErrors(scripts: Scripts): string[] {
  const skipped = [
    ...new Set(
      runsOf(scripts, "build")
        .filter((run) => run.skipsLibCheck)
        .map((run) => run.program),
    ),
  ];
  const typecheck = runsOf(scripts, "typecheck");
  const covered = typecheck
    .filter((run) => !run.skipsLibCheck)
    .map((run) => run.program);
  return skipped
    .filter((program) => !covered.includes(program))
    .map((program) => {
      const lead = `package.json: script "build" passes --skipLibCheck to tsc for ${program}, but`;
      const fix = `Make "typecheck" run \`tsc --noEmit${program === ROOT_PROGRAM ? "" : ` -p ${program}`}\` without --skipLibCheck, or drop --skipLibCheck from "build".`;
      if (!scripts.has("typecheck"))
        return `${lead} there is no "typecheck" script. ${fix}`;
      if (typecheck.some((run) => run.program === program))
        return `${lead} script "typecheck" also passes --skipLibCheck for it. ${fix}`;
      return `${lead} script "typecheck" runs no full tsc over it. ${fix}`;
    });
}

function releaseErrors(scripts: Scripts): string[] {
  if (
    !scripts.has("release") ||
    reachable(scripts, "release").includes("typecheck")
  )
    return [];
  return [
    `package.json: script "release" does not run "typecheck", so a release can publish a build that skipped the lib check. Add \`pnpm run typecheck\` to "release" before it builds or publishes.`,
  ];
}

interface TsconfigFacts {
  /** `undefined` when the file sets no `compilerOptions.skipLibCheck`. */
  skipLibCheck: boolean | undefined;
  /** The `extends` entries that name a local file, as repository-relative paths. */
  parents: string[];
}

function propertyNamed(
  object: ts.Expression | undefined,
  name: string,
): ts.Expression | undefined {
  if (object === undefined || !ts.isObjectLiteralExpression(object))
    return undefined;
  for (const item of object.properties)
    if (
      ts.isPropertyAssignment(item) &&
      (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) &&
      item.name.text === name
    )
      return item.initializer;
  return undefined;
}

function readFacts(root: string, file: string): TsconfigFacts | undefined {
  const path = join(root, file);
  if (!existsSync(path)) return undefined;
  const source = ts.parseJsonText(path, readFileSync(path, "utf8"));
  const object = source.statements[0]?.expression;
  const flag = propertyNamed(
    propertyNamed(object, "compilerOptions"),
    "skipLibCheck",
  );
  const extended = propertyNamed(object, "extends");
  const entries: readonly ts.Expression[] =
    extended === undefined
      ? []
      : ts.isArrayLiteralExpression(extended)
        ? extended.elements
        : [extended];
  return {
    skipLibCheck:
      flag === undefined ? undefined : flag.kind === ts.SyntaxKind.TrueKeyword,
    parents: entries
      .filter(ts.isStringLiteral)
      .map((entry) => entry.text)
      .filter((entry) => entry.startsWith("./") || entry.startsWith("../"))
      .map((entry) => {
        const target = posix.join(posix.dirname(file), entry);
        return target.endsWith(".json") ? target : `${target}.json`;
      })
      .filter((target) => !target.startsWith("..")),
  };
}

/** The file whose `compilerOptions.skipLibCheck` decides the value `file` ends up with, and that value. A file's own setting overrides what it extends, a later `extends` entry overrides an earlier one, and a package preset is not read: it counts only when it is this package's, and this package ships none. */
function skipLibCheckSetting(
  root: string,
  file: string,
  visited: Set<string> = new Set(),
): { file: string; value: boolean } | undefined {
  if (visited.has(file)) return undefined;
  visited.add(file);
  const facts = readFacts(root, file);
  if (facts === undefined) return undefined;
  if (facts.skipLibCheck !== undefined)
    return { file, value: facts.skipLibCheck };
  for (const parent of facts.parents.toReversed()) {
    const inherited = skipLibCheckSetting(root, parent, visited);
    if (inherited !== undefined) return inherited;
  }
  return undefined;
}

function usedPrograms(scripts: Scripts): Map<string, string[]> {
  const used = new Map<string, string[]>([[ROOT_PROGRAM, []]]);
  for (const [name, script] of scripts)
    for (const run of ownRuns(script))
      used.set(run.program, [...(used.get(run.program) ?? []), name]);
  return used;
}

function skipLibCheckErrors(root: string, scripts: Scripts): string[] {
  const setters = new Map<string, string[]>();
  for (const [program, users] of usedPrograms(scripts)) {
    const setting = skipLibCheckSetting(root, program);
    if (setting?.value !== true) continue;
    const reader = users.length
      ? `${program} (script ${[...new Set(users)].map((name) => `"${name}"`).join(", ")})`
      : `${program} (the root program)`;
    setters.set(setting.file, [...(setters.get(setting.file) ?? []), reader]);
  }
  return [...setters].map(
    ([file, readers]) =>
      `${file}: sets compilerOptions.skipLibCheck: true, read by ${readers.join(", ")}. Remove it so "typecheck" checks the declaration files; "build" may pass --skipLibCheck on the command line for the program "typecheck" covers.`,
  );
}

/** The package.json and tsconfig facts that keep `typecheck` the lib check no other script skips: `build` skips the lib check only over a program `typecheck` checks in full, no tsconfig a script uses or the root one sets `skipLibCheck: true`, and `release` runs `typecheck`. */
export function checkTypecheckCoverage(root: string): string[] {
  const manifestPath = join(root, "package.json");
  if (!existsSync(manifestPath)) return [];
  const scripts = new Map(
    Object.entries(
      parseManifest(readFileSync(manifestPath, "utf8")).scripts ?? {},
    ),
  );
  return [
    ...skipCoverageErrors(scripts),
    ...skipLibCheckErrors(root, scripts),
    ...releaseErrors(scripts),
  ];
}
