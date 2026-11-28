import { posix } from "node:path";
import { isMap, isScalar, parseDocument, visit, type YAMLMap } from "yaml";

import { readText, type CoverageFiles } from "./coverage-files.ts";
import { workspaceDirectories } from "./docs-compat.ts";
import { parseManifest } from "./package.ts";
import { stepsOf, type Target } from "./script-steps.ts";
import { tscRun } from "./tsc-invocation.ts";
import {
  definesProgram,
  withExtends,
  withReferences,
} from "./tsconfig-chain.ts";

const TSCONFIG = /(?:^|\/)tsconfig[^/]*\.json$/u;
const OUTSIDE_PROJECT = /(?:^|\/)node_modules\/|^\.agents\//u;
const WORKFLOW =
  /^\.github\/(?:workflows\/[^/]+|actions\/(?:.+\/)?action)\.ya?ml$/u;
const WORD_SEPARATORS = /[\s"'`=,;&|()]+/u;

/** A command line text and the repository directory it runs from, `""` for the root. */
interface Command {
  directory: string;
  text: string;
}

function within(path: string): string | undefined {
  const normal = posix.normalize(path);
  return normal === ".." || normal.startsWith("../") ? undefined : normal;
}

/** The directories a step pointed at `targets` runs in; a `--filter` or `-r` may name any workspace member, so it counts as all of them. */
function targetDirectories(
  cwd: string,
  targets: readonly Target[],
  members: readonly string[],
): string[] {
  if (targets.length === 0) return [cwd];
  return targets.flatMap((target) => {
    if (target.kind !== "dir") return members;
    const directory = within(posix.join(cwd, target.path));
    return directory === undefined ? [] : [directory];
  });
}

/** The tsconfig files a command names as a word, such as the projects of a wrapper script (`tsx scripts/typecheck.ts tsconfig.tests.json`) or a workflow input. */
function namedConfigs(command: Command): string[] {
  return command.text.split(WORD_SEPARATORS).flatMap((word) => {
    const file = TSCONFIG.test(word)
      ? within(posix.join(command.directory, word))
      : undefined;
    return file === undefined ? [] : [file];
  });
}

/** What one command reads: the tsconfig files its `tsc`, `vue-tsc` and `antelopejs-tsc` runs check, and the package directories whose scripts it runs. */
interface Reads {
  programs: string[];
  packages: string[];
}

/** The {@link Reads} of one command, following its `cd` lines and the package each run is pointed at. A subshell may undo a `cd`, so in a command with one each run also counts from where the command started. */
function commandReads(
  files: CoverageFiles,
  members: readonly string[],
  command: Command,
): Reads {
  const reads: Reads = { programs: [], packages: [] };
  const subshell = command.text.includes("(");
  let cwd: string | undefined = command.directory;
  for (const step of stepsOf(command.text)) {
    if (step.kind === "cd") {
      cwd =
        cwd === undefined || /[$~]/u.test(step.path)
          ? undefined
          : within(posix.join(cwd, step.path));
      continue;
    }
    if (cwd === undefined || step.kind === "test") continue;
    const bases = subshell ? [cwd, command.directory] : [cwd];
    const directories = bases.flatMap((base) =>
      targetDirectories(base, step.targets, members),
    );
    if (step.kind === "script") {
      reads.packages.push(...directories);
      continue;
    }
    const run = tscRun(step.command, step.args);
    for (const directory of directories) {
      const named = run.programs.flatMap((program) => {
        const file = within(posix.join(directory, program));
        return file === undefined ? [] : [file];
      });
      reads.programs.push(
        ...(run.build ? withReferences(files, named) : named),
      );
    }
  }
  return reads;
}

function scriptCommands(files: CoverageFiles, directory: string): Command[] {
  const text = readText(files, posix.join(directory, "package.json"));
  if (text === undefined) return [];
  try {
    return Object.values(parseManifest(text).scripts ?? {}).map((script) => ({
      directory,
      text: script,
    }));
  } catch {
    return [];
  }
}

function scalarText(node: unknown): string | undefined {
  return isScalar(node) ? String(node.value) : undefined;
}

/** The directory a `run` step starts in: its own `working-directory`, else the nearest `defaults.run.working-directory` of its job or workflow. */
function workingDirectory(
  step: YAMLMap,
  ancestors: readonly unknown[],
): string | undefined {
  const own = scalarText(step.get("working-directory", true));
  if (own !== undefined) return own;
  for (const ancestor of ancestors.toReversed())
    if (isMap(ancestor)) {
      const inherited = scalarText(
        ancestor.getIn(["defaults", "run", "working-directory"], true),
      );
      if (inherited !== undefined) return inherited;
    }
  return undefined;
}

/** The `run` steps of a workflow or composite action, each from its working directory, and the `with` inputs of its steps, from the root. */
function workflowCommands(files: CoverageFiles, file: string): Command[] {
  const text = readText(files, file);
  if (text === undefined) return [];
  const document = parseDocument(text);
  if (document.errors.length) return [];
  const commands: Command[] = [];
  visit(document, {
    Pair(_, pair) {
      if (scalarText(pair.key) !== "with" || !isMap(pair.value)) return;
      for (const input of pair.value.items) {
        const value = scalarText(input.value);
        if (value !== undefined) commands.push({ directory: "", text: value });
      }
    },
    Map(_, map, path) {
      const run = scalarText(map.get("run", true));
      if (run === undefined) return;
      const directory = within(workingDirectory(map, path) ?? ".");
      if (directory !== undefined)
        commands.push({
          directory: directory === "." ? "" : directory,
          text: run,
        });
    },
  });
  return commands;
}

function memberDirectories(root: string): string[] {
  try {
    return workspaceDirectories(root);
  } catch {
    return [];
  }
}

/** Each git-tracked tsconfig that defines a program and that no `tsc`, `vue-tsc` or `antelopejs-tsc` run reads, through `-p`, `-b` and its references, or `extends`, and that no command names. The runs are those of the scripts of the repository, of its workspace members and of any package a script or step runs a script in (`pnpm -C web run typecheck`), and of the steps of `.github` workflows and composite actions. Such a project rots unchecked until a catch-up fix. */
export function orphanProgramErrors(files: CoverageFiles): string[] {
  const members = memberDirectories(files.root);
  const commands = files.tracked
    .filter((file) => WORKFLOW.test(file))
    .flatMap((file) => workflowCommands(files, file));
  const packages = new Set(["", ...members]);
  for (const directory of packages)
    commands.push(...scriptCommands(files, directory));
  const programs: string[] = [];
  for (const command of commands) {
    const reads = commandReads(files, members, command);
    programs.push(...reads.programs, ...namedConfigs(command));
    for (const directory of reads.packages)
      if (!packages.has(directory)) {
        packages.add(directory);
        commands.push(...scriptCommands(files, directory));
      }
  }
  const read = new Set(withExtends(files, programs));
  return files.tracked
    .filter(
      (file) =>
        TSCONFIG.test(file) &&
        !OUTSIDE_PROJECT.test(file) &&
        !read.has(file) &&
        definesProgram(files, file),
    )
    .toSorted()
    .map(
      (file) =>
        `${file}: no script or workflow typechecks this project. Add \`tsc --noEmit -p ${file}\` to "typecheck", or delete the file.`,
    );
}
