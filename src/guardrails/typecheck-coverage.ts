import { parseManifest } from "./package.ts";
import {
  coverageFiles,
  readText,
  unreadableNotes,
  type CoverageFiles,
} from "./coverage-files.ts";
import { releaseHooks } from "./release-hooks.ts";
import { matchingScripts, stepsOf } from "./script-steps.ts";
import {
  reportedFile,
  skipLibCheckSetting,
  withReferences,
} from "./tsconfig-chain.ts";
import { ROOT_PROGRAM, tscRun, type TscRun } from "./tsc-invocation.ts";

const MAX_DEPTH = 5;

type Scripts = ReadonlyMap<string, string>;

interface Reached {
  /** Scripts of this package that the start runs, itself included. */
  local: Set<string>;
  /** Names run in another package (`--filter`, `-r`), which this package cannot resolve. */
  elsewhere: Set<string>;
}

/** The scripts `name` runs and everything `extra` commands run, to a bounded depth: through package managers and `run-s`, with the `pre<script>` hook npm and pnpm run before each. */
function reach(
  scripts: Scripts,
  name: string,
  extra: readonly string[] = [],
): Reached {
  const reached: Reached = { local: new Set(), elsewhere: new Set() };
  const queue: { text: string; depth: number }[] = [];
  const enter = (script: string, depth: number): void => {
    const text = scripts.get(script);
    if (text === undefined || depth > MAX_DEPTH || reached.local.has(script))
      return;
    reached.local.add(script);
    enter(`pre${script}`, depth);
    queue.push({ text, depth });
  };
  enter(name, 0);
  queue.push(...extra.map((text) => ({ text, depth: 0 })));
  for (const { text, depth } of queue)
    for (const step of stepsOf(text)) {
      if (step.kind !== "script") continue;
      for (const script of matchingScripts(step.names, scripts.keys()))
        if (step.elsewhere) reached.elsewhere.add(script);
        else enter(script, depth + 1);
    }
  return reached;
}

function ownRuns(script: string): TscRun[] {
  return stepsOf(script).flatMap((step) =>
    step.kind === "tsc" ? [tscRun(step.args)] : [],
  );
}

function runsOf(scripts: Scripts, name: string): TscRun[] {
  return [...reach(scripts, name).local].flatMap((script) =>
    ownRuns(scripts.get(script) ?? ""),
  );
}

function skipCoverageErrors(scripts: Scripts): string[] {
  const skipped = [
    ...new Set(
      runsOf(scripts, "build")
        .filter((run) => run.skipsLibCheck)
        .flatMap((run) => run.programs),
    ),
  ];
  const typecheck = runsOf(scripts, "typecheck");
  const covered = typecheck
    .filter((run) => !run.skipsLibCheck)
    .flatMap((run) => run.programs);
  return skipped
    .filter((program) => !covered.includes(program))
    .map((program) => {
      const lead = `package.json: script "build" passes --skipLibCheck to tsc for ${program}, but`;
      const fix = `Make "typecheck" run \`tsc --noEmit${program === ROOT_PROGRAM ? "" : ` -p ${program}`}\` without --skipLibCheck, or drop --skipLibCheck from "build".`;
      if (!scripts.has("typecheck"))
        return `${lead} there is no "typecheck" script. ${fix}`;
      if (typecheck.some((run) => run.programs.includes(program)))
        return `${lead} script "typecheck" also passes --skipLibCheck for it. ${fix}`;
      return `${lead} script "typecheck" runs no full tsc over it. ${fix}`;
    });
}

function releaseErrors(files: CoverageFiles, scripts: Scripts): string[] {
  if (!scripts.has("release")) return [];
  const reached = reach(scripts, "release", releaseHooks(files));
  if (reached.local.has("typecheck") || reached.elsewhere.has("typecheck"))
    return [];
  return [
    `package.json: script "release" does not run "typecheck", so a release can publish a build that skipped the lib check. Add \`pnpm run typecheck\` to "release" before it builds or publishes, or to a release-it \`before:init\` hook.`,
  ];
}

/** The tsconfig files each script reads through `tsc`, and the root one, with the scripts that read each. */
function usedPrograms(
  files: CoverageFiles,
  scripts: Scripts,
): Map<string, string[]> {
  const used = new Map<string, string[]>([[ROOT_PROGRAM, []]]);
  for (const [name, script] of scripts)
    for (const run of ownRuns(script)) {
      const programs = run.build
        ? withReferences(files, run.programs)
        : run.programs;
      for (const program of programs)
        used.set(program, [...(used.get(program) ?? []), name]);
    }
  return used;
}

function skipLibCheckErrors(files: CoverageFiles, scripts: Scripts): string[] {
  const readers = new Map<
    string,
    { sets: boolean; by: string[]; from: string }
  >();
  for (const [program, users] of usedPrograms(files, scripts)) {
    const setting = skipLibCheckSetting(files, program);
    const target = setting?.value ? reportedFile(files, setting) : undefined;
    if (setting === undefined || target === undefined) continue;
    const reader = users.length
      ? `${program} (script ${[...new Set(users)].map((name) => `"${name}"`).join(", ")})`
      : `${program} (the root program)`;
    const known = readers.get(target.file);
    if (known) known.by.push(reader);
    else
      readers.set(target.file, {
        sets: target.sets,
        by: [reader],
        from: setting.chain.at(-1) ?? target.file,
      });
  }
  return [...readers].map(([file, { sets, by, from }]) =>
    sets
      ? `${file}: sets compilerOptions.skipLibCheck: true, read by ${by.join(", ")}. Remove it so "typecheck" checks the declaration files; "build" may pass --skipLibCheck on the command line for the program "typecheck" covers.`
      : `${file}: inherits compilerOptions.skipLibCheck: true from ${from}, which git ignores, read by ${by.join(", ")}. Set \`skipLibCheck: false\` here so "typecheck" checks the declaration files; "build" may pass --skipLibCheck on the command line for the program "typecheck" covers.`,
  );
}

function scriptsOf(files: CoverageFiles): Scripts | undefined {
  const text = readText(files, "package.json");
  if (text === undefined) return undefined;
  try {
    return new Map(Object.entries(parseManifest(text).scripts ?? {}));
  } catch {
    files.unreadable.set("package.json", "invalid JSON");
    return undefined;
  }
}

/** The package.json and tsconfig facts that keep `typecheck` the lib check no other script skips: `build` skips the lib check only over a program `typecheck` checks in full, no tsconfig a script uses or the root one sets `skipLibCheck: true`, and `release` runs `typecheck`. Under `check` a broken fact is an error; otherwise it is a `Note:` advisory. A file that cannot be read yields a `Note:` advisory and never an error. */
export function checkTypecheckCoverage(root: string, check: boolean) {
  const files = coverageFiles(root);
  const scripts = scriptsOf(files);
  const findings =
    scripts === undefined
      ? []
      : [
          ...skipCoverageErrors(scripts),
          ...skipLibCheckErrors(files, scripts),
          ...releaseErrors(files, scripts),
        ];
  const notes = check
    ? unreadableNotes(files)
    : [...findings, ...unreadableNotes(files)];
  return {
    errors: check ? findings : [],
    advisories: notes.map((note) => `Note: ${note}`),
  };
}
