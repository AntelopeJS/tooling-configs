import { posix } from "node:path";
import { isScalar, parseDocument, visit, type YAMLMap } from "yaml";

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
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/u;
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

/** The tsconfig files the `tsc`, `vue-tsc` and `antelopejs-tsc` runs of one command read, following its `cd` lines and the package each run is pointed at. */
function programsRead(
  files: CoverageFiles,
  members: readonly string[],
  command: Command,
): string[] {
  let cwd: string | undefined = command.directory;
  const programs: string[] = [];
  for (const step of stepsOf(command.text)) {
    if (step.kind === "cd") {
      cwd =
        cwd === undefined || /[$~]/u.test(step.path)
          ? undefined
          : within(posix.join(cwd, step.path));
      continue;
    }
    if (step.kind !== "tsc" || cwd === undefined) continue;
    const run = tscRun(step.command, step.args);
    for (const directory of targetDirectories(cwd, step.targets, members)) {
      const named = run.programs.flatMap((program) => {
        const file = within(posix.join(directory, program));
        return file === undefined ? [] : [file];
      });
      programs.push(...(run.build ? withReferences(files, named) : named));
    }
  }
  return programs;
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

function stringAt(map: YAMLMap, key: string): string | undefined {
  const value = map.get(key, true);
  return isScalar(value) ? String(value.value) : undefined;
}

/** The `run` steps of a workflow, each from its `working-directory`, and every other string in it, such as an action input, from the root. */
function workflowCommands(files: CoverageFiles, file: string): Command[] {
  const text = readText(files, file);
  if (text === undefined) return [];
  const document = parseDocument(text);
  if (document.errors.length) return [];
  const commands: Command[] = [];
  visit(document, {
    Scalar(_, scalar) {
      commands.push({ directory: "", text: String(scalar.value) });
    },
    Map(_, map) {
      const run = stringAt(map, "run");
      if (run === undefined) return;
      const directory = within(stringAt(map, "working-directory") ?? ".");
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

/** Each git-tracked tsconfig that defines a program and that no `tsc`, `vue-tsc` or `antelopejs-tsc` run reads, through `-p`, `-b` and its references, or `extends`, and that no command names: in a script of the repository or a workspace member, or in a `.github/workflows` file. Such a project rots unchecked until a catch-up fix. */
export function orphanProgramErrors(files: CoverageFiles): string[] {
  const members = memberDirectories(files.root);
  const commands = [
    ...["", ...members].flatMap((directory) =>
      scriptCommands(files, directory),
    ),
    ...files.tracked
      .filter((file) => WORKFLOW.test(file))
      .flatMap((file) => workflowCommands(files, file)),
  ];
  const read = new Set(
    withExtends(
      files,
      commands.flatMap((command) => [
        ...programsRead(files, members, command),
        ...namedConfigs(command),
      ]),
    ),
  );
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
