import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isMap,
  isScalar,
  isSeq,
  Scalar,
  type Document,
  type YAMLMap,
} from "yaml";

import { coveragePaths, SKILLS_DIRECTORY } from "./ci-coverage-record.ts";
import { handWrittenJobs, stepsOf } from "./ci-hand-jobs.ts";
import { gitFiles } from "./files.ts";
import { isText, neededIds, referencedIds } from "./workflow-needs.ts";

/** The input of ci-node.yml that lists the formal checks to run, one job each. */
const FORMAL_CHECKS_INPUT = "formal-checks";

/** A formal check skill of the repository: the folder under `.agents/skills` with a `check.mjs`, and the text of its SKILL.md. */
interface FormalSkill {
  name: string;
  markdown: string;
}

/** The formal skills of a repository and the files it holds, from which sync writes the `formal-checks` input. */
export interface FormalPlan {
  skills: readonly FormalSkill[];
  files: readonly string[];
}

interface FormalCheck {
  skill: string;
  run?: string;
  paths?: string[];
}

interface WrittenCheck {
  skill: string;
  run?: string | null;
  paths?: string[] | null;
}

interface ExtraCommands {
  moved: MovedCheck[];
  apply: () => void;
}

interface MovedCheck {
  skill: string;
  line: string;
  hasArguments: boolean;
}

const SKILL_FOLDER = /^formal-[\w-]+$/;
const CHECK_LINE =
  /^node \.agents\/skills\/(formal-[\w-]+)\/check\.mjs(?:\s+(\S.*))?$/;
const CHECK_PATH = /\.agents\/skills\/(formal-[\w-]+)\/check\.mjs/;
const SETUP_LINE = /^(?:corepack enable|pnpm install(?:\s.*)?)$/;
const MOVABLE_JOB_KEYS = new Set([
  "name",
  "runs-on",
  "timeout-minutes",
  "permissions",
  "steps",
]);
const MOVABLE_STEP_KEYS = new Set(["name", "uses", "with", "run"]);
const MOVABLE_ACTIONS = new Set([
  "actions/checkout",
  "actions/setup-node",
  "pnpm/action-setup",
  "actions/setup-java",
  "actions/cache",
  "actions/cache/restore",
  "actions/cache/save",
]);

/** The formal check skills under `root` and the repository's file list; no file list when there is no skill, so a repository without one needs no git. */
export function formalPlan(root: string): FormalPlan {
  const directory = join(root, SKILLS_DIRECTORY);
  const names = existsSync(directory)
    ? readdirSync(directory)
        .filter(
          (name) =>
            SKILL_FOLDER.test(name) &&
            existsSync(join(directory, name, "check.mjs")),
        )
        .sort()
    : [];
  const skills = names.map((name) => {
    const markdown = join(directory, name, "SKILL.md");
    return {
      name,
      markdown: existsSync(markdown) ? readFileSync(markdown, "utf8") : "",
    };
  });
  return { skills, files: skills.length ? gitFiles(root) : [] };
}

function isWrittenCheck(value: unknown): value is WrittenCheck {
  return (
    typeof value === "object" &&
    value !== null &&
    "skill" in value &&
    typeof value.skill === "string" &&
    (!("run" in value) || value.run === null || isText(value.run)) &&
    (!("paths" in value) ||
      value.paths === null ||
      (Array.isArray(value.paths) && value.paths.every(isText)))
  );
}

function checkOf({ skill, run, paths }: WrittenCheck): FormalCheck {
  const check: FormalCheck = { skill };
  if (isText(run)) check.run = run;
  if (paths?.length) check.paths = paths;
  return check;
}

function existingChecks(
  inputs: YAMLMap | undefined,
  path: string,
): FormalCheck[] {
  const node = inputs?.get(FORMAL_CHECKS_INPUT, true);
  const text = isScalar(node) ? node.value : undefined;
  if (node === undefined || text === null || (isText(text) && !text.trim()))
    return [];
  let parsed: unknown;
  try {
    parsed = isText(text) ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed) || !parsed.every(isWrittenCheck))
    throw new Error(
      `${path}: the ${FORMAL_CHECKS_INPUT} input is not a JSON array of objects with a "skill" string, an optional "run" string and an optional "paths" list of strings. Fix it, then rerun antelopejs-sync.`,
    );
  return parsed.map(checkOf);
}

function runLines(step: YAMLMap): string[] {
  const run = step.get("run");
  return isText(run)
    ? run
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

function checkLine(line: string): MovedCheck | undefined {
  const match = CHECK_LINE.exec(line);
  return match
    ? { skill: match[1], line, hasArguments: match[2] !== undefined }
    : undefined;
}

function onlyKeys(map: YAMLMap, allowed: ReadonlySet<string>): boolean {
  return map.items.every(
    ({ key }) => isScalar(key) && allowed.has(String(key.value)),
  );
}

function stepChecks(step: YAMLMap): MovedCheck[] | undefined {
  if (!onlyKeys(step, MOVABLE_STEP_KEYS)) return undefined;
  const uses = step.get("uses");
  if (isText(uses))
    return MOVABLE_ACTIONS.has(uses.split("@")[0]) ? [] : undefined;
  const moved: MovedCheck[] = [];
  const lines = runLines(step);
  if (!lines.length) return undefined;
  for (const line of lines) {
    const check = checkLine(line);
    if (check) moved.push(check);
    else if (!SETUP_LINE.test(line)) return undefined;
  }
  return moved;
}

/**
 * The checks a formal job runs when ci-node.yml can run them instead: the job sets up Node, pnpm, Java and a cache, and
 * its `run` lines only enable corepack, install with pnpm and run a skill's `check.mjs`, with its arguments. A job with
 * any other key, step key, action or command, a skill that has no folder, or no check at all stays where it is.
 */
function movedChecks(
  job: YAMLMap,
  known: ReadonlySet<string>,
): MovedCheck[] | undefined {
  if (!onlyKeys(job, MOVABLE_JOB_KEYS)) return undefined;
  const moved: MovedCheck[] = [];
  for (const step of stepsOf(job)) {
    const found = stepChecks(step);
    if (found === undefined) return undefined;
    moved.push(...found);
  }
  return moved.length && moved.every(({ skill }) => known.has(skill))
    ? moved
    : undefined;
}

function isFormalJob(id: string, job: YAMLMap): boolean {
  return (
    id.startsWith("formal") ||
    stepsOf(job).some((step) => CHECK_PATH.test(String(step.get("run") ?? "")))
  );
}

function skillsRunBy(job: YAMLMap): string[] {
  return stepsOf(job).flatMap((step) =>
    String(step.get("run") ?? "")
      .split("\n")
      .flatMap((line) => CHECK_PATH.exec(line)?.[1] ?? []),
  );
}

function readByOthers(jobs: YAMLMap, id: string): boolean {
  return jobs.items.some(
    ({ key, value }) =>
      isScalar(key) &&
      key.value !== id &&
      isMap(value) &&
      referencedIds(value).includes(id),
  );
}

interface Absorbed {
  moved: MovedCheck[];
  removed: string[];
  kept: Set<string>;
}

function absorbJobs(jobs: YAMLMap, known: ReadonlySet<string>): Absorbed {
  const absorbed: Absorbed = { moved: [], removed: [], kept: new Set() };
  for (const { id, job } of handWrittenJobs(jobs)) {
    if (!isFormalJob(id, job)) continue;
    const moved = movedChecks(job, known);
    if (moved === undefined || readByOthers(jobs, id))
      for (const skill of skillsRunBy(job)) absorbed.kept.add(skill);
    else {
      absorbed.moved.push(...moved);
      absorbed.removed.push(id);
    }
  }
  return absorbed;
}

function dropNeeds(jobs: YAMLMap, removed: ReadonlySet<string>): boolean {
  let changed = false;
  for (const { value: job } of jobs.items) {
    if (!isMap(job)) continue;
    const needs = job.get("needs", true);
    const listed = neededIds(job);
    const left = listed.filter((id) => !removed.has(id));
    if (left.length === listed.length) continue;
    if (isSeq(needs) && left.length)
      needs.items = needs.items.filter(
        (entry) => !(isScalar(entry) && removed.has(String(entry.value))),
      );
    else job.delete("needs");
    changed = true;
  }
  return changed;
}

function moveExtraCommands(
  inputs: YAMLMap | undefined,
  known: ReadonlySet<string>,
): ExtraCommands {
  const commands = inputs?.get("extra-commands", true);
  if (!inputs || !isScalar(commands) || !isText(commands.value))
    return { moved: [], apply: () => undefined };
  const lines = commands.value.split("\n");
  const moved = lines.flatMap((line) => {
    const check = checkLine(line.trim());
    return check && known.has(check.skill) ? [check] : [];
  });
  const left = lines.filter(
    (line) => !moved.some((m) => m.line === line.trim()),
  );
  return {
    moved,
    apply: () => {
      if (left.every((line) => !line.trim())) inputs.delete("extra-commands");
      else commands.value = left.join("\n");
    },
  };
}

function entryText({ skill, run, paths }: FormalCheck): string {
  const fields = [`"skill": ${JSON.stringify(skill)}`];
  if (run !== undefined) fields.push(`"run": ${JSON.stringify(run)}`);
  if (paths !== undefined)
    fields.push(`"paths": [${paths.map((p) => JSON.stringify(p)).join(", ")}]`);
  return `{${fields.join(", ")}}`;
}

function movedRun(moved: readonly MovedCheck[], skill: string) {
  const lines = [
    ...new Set(
      moved.filter((check) => check.skill === skill).map(({ line }) => line),
    ),
  ];
  return moved.some((check) => check.skill === skill && check.hasArguments)
    ? lines.join("\n")
    : undefined;
}

function compareNames(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function desiredChecks(
  plan: FormalPlan,
  existing: readonly FormalCheck[],
  moved: readonly MovedCheck[],
  kept: ReadonlySet<string>,
): FormalCheck[] {
  return plan.skills
    .filter(({ name }) => !kept.has(name))
    .toSorted((left, right) => compareNames(left.name, right.name))
    .map(({ name, markdown }) => {
      const before = existing.find(({ skill }) => skill === name);
      const run = before?.run ?? movedRun(moved, name);
      const paths = coveragePaths(markdown, plan.files, name) ?? before?.paths;
      const check: FormalCheck = { skill: name };
      if (run !== undefined) check.run = run;
      if (paths !== undefined) check.paths = paths;
      return check;
    });
}

function setChecks(
  document: Document,
  caller: YAMLMap,
  inputs: YAMLMap | undefined,
  checks: readonly FormalCheck[],
): boolean {
  const text = checks.length
    ? `[\n${checks.map((check) => `  ${entryText(check)}`).join(",\n")}\n]\n`
    : "";
  const current = inputs?.get(FORMAL_CHECKS_INPUT);
  if (text === "") return inputs?.delete(FORMAL_CHECKS_INPUT) === true;
  if (current === text) return false;
  const node = new Scalar(text);
  node.type = Scalar.BLOCK_LITERAL;
  if (inputs) inputs.set(FORMAL_CHECKS_INPUT, node);
  else caller.set("with", document.createNode({ [FORMAL_CHECKS_INPUT]: node }));
  return true;
}

/**
 * Moves the formal checks of the workflow at `path` into the `formal-checks` input of `caller`, the job calling
 * ci-node.yml, which then runs each as a Formal job. The input holds one entry per skill of `plan` that no job left in
 * the file runs, sorted by skill and written as a block literal of one JSON object per line. An entry keeps the `run` of the
 * entry it replaces, else the full line a moved job or an `extra-commands` line ran when it had arguments; its `paths`
 * are the files the skill's coverage record lists, else those of the entry it replaces. A formal job that only sets up
 * Node, Java and a cache and runs `check.mjs` lines, and that no other job reads, is deleted and removed from the `needs` of
 * every job; a formal job that does more stays and its skills stay out of the input. An `extra-commands` line that only
 * runs a skill's `check.mjs` is removed, and the input with it when nothing else is left. Throws when the current
 * `formal-checks` is not a JSON array of objects with a `skill` string.
 */
export function moveFormalChecks(
  document: Document,
  jobs: YAMLMap,
  caller: YAMLMap,
  plan: FormalPlan,
  path: string,
): boolean {
  const known = new Set(plan.skills.map(({ name }) => name));
  const withInputs = caller.get("with", true);
  const inputs = isMap(withInputs) ? withInputs : undefined;
  const existing = existingChecks(inputs, path);
  const absorbed = absorbJobs(jobs, known);
  const extra = moveExtraCommands(inputs, known);
  const checks = desiredChecks(
    plan,
    existing,
    [...absorbed.moved, ...extra.moved],
    absorbed.kept,
  );
  for (const id of absorbed.removed) jobs.delete(id);
  const needs = dropNeeds(jobs, new Set(absorbed.removed));
  const lines = extra.moved.length > 0;
  extra.apply();
  const input = setChecks(document, caller, inputs, checks);
  if ((lines || input) && inputs?.items.length === 0) caller.delete("with");
  return absorbed.removed.length > 0 || needs || lines || input;
}
