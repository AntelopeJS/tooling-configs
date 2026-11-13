import { parseDocument } from "yaml";

import {
  isObject,
  isString,
  parseJson,
  type JsonObject,
  type JsonValue,
} from "./json.ts";

const CI_NODE =
  /^AntelopeJS\/\.github\/\.github\/workflows\/ci-node\.yml@(\S+)$/;
const CI_EVENTS = new Set([
  "pull_request",
  "pull_request_target",
  "push",
  "merge_group",
]);
const WINDOWS = /windows/i;
const EXPRESSION = /\$\{\{/;
const MATRIX_KEY = /\bmatrix\.([\w-]+)/g;
const ALWAYS = /^\s*\$\{\{\s*true\s*\}\}\s*$/;
const NEVER = /^\s*\$\{\{\s*false\s*\}\}\s*$/;

/** The workflow as JSON, its anchors, aliases and merge keys resolved; undefined when the YAML does not parse. */
function workflow(text: string): JsonObject | undefined {
  const document = parseDocument(text, { merge: true });
  if (document.errors.length) return undefined;
  const value = parseJson(
    JSON.stringify(document.toJS({ maxAliasCount: 1000 }) ?? null),
  );
  return isObject(value) ? value : undefined;
}

/** Every string in `value`, nested lists and object values included. */
function texts(value: JsonValue): string[] {
  if (value === null) return [];
  if (isString(value)) return [value];
  if (Array.isArray(value)) return value.flatMap(texts);
  if (isObject(value)) return Object.values(value).flatMap(texts);
  return [];
}

function own(source: JsonObject, key: string): JsonValue {
  return Object.hasOwn(source, key) ? source[key] : null;
}

function at(value: JsonValue, keys: readonly string[]): JsonValue {
  return keys.reduce<JsonValue>(
    (node, key) => (node !== null && isObject(node) ? own(node, key) : null),
    value,
  );
}

function triggers(on: JsonValue): string[] {
  if (on !== null && isObject(on)) return Object.keys(on);
  return texts(on);
}

function entries(value: JsonValue): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

/** The values the matrix gives `key`: its own list and `include` entries, less the values a single-key `exclude` entry drops. */
function legs(matrix: JsonObject, key: string): string[] {
  const dropped = new Set(
    entries(own(matrix, "exclude"))
      .filter((entry) => Object.keys(entry).length === 1)
      .flatMap((entry) => texts(own(entry, key))),
  );
  return [
    ...texts(own(matrix, key)),
    ...entries(own(matrix, "include")).flatMap((entry) =>
      texts(own(entry, key)),
    ),
  ].filter((value) => !dropped.has(value));
}

function runnerIsWindows(job: JsonObject): boolean {
  const labels = texts(own(job, "runs-on"));
  if (labels.some((label) => WINDOWS.test(label))) return true;
  const strategy = own(job, "strategy");
  const matrix =
    strategy !== null && isObject(strategy) ? own(strategy, "matrix") : null;
  if (matrix === null) return false;
  if (!isObject(matrix))
    return texts(matrix).some((value) => WINDOWS.test(value));
  return labels
    .filter((label) => EXPRESSION.test(label))
    .flatMap((label) =>
      [...label.matchAll(MATRIX_KEY)].map((match) => match[1]),
    )
    .some((key) => legs(matrix, key).some((value) => WINDOWS.test(value)));
}

async function jobRunsOnWindows(
  job: JsonObject,
  windowsDefault: (ref: string) => Promise<boolean>,
): Promise<boolean> {
  const condition = own(job, "if");
  if (condition === false || (isString(condition) && NEVER.test(condition)))
    return false;
  const uses = own(job, "uses");
  const ref = isString(uses) ? CI_NODE.exec(uses)?.[1] : undefined;
  if (ref === undefined) return runnerIsWindows(job);
  const windows = at(job, ["with", "windows"]);
  if (windows === null) return windowsDefault(ref);
  return windows === true || (isString(windows) && ALWAYS.test(windows));
}

/** Whether a ci-node.yml, given as its text, defaults its `windows` input to true. False when the YAML does not parse. */
export function windowsByDefault(ciNode: string): boolean {
  const parsed = workflow(ciNode);
  return (
    parsed !== undefined &&
    at(parsed, ["on", "workflow_call", "inputs", "windows", "default"]) === true
  );
}

/**
 * Whether a workflow file runs a job on Windows for pull requests or pushes: a ci-node.yml caller with
 * `windows: true`, or with no `windows` input when `windowsDefault` says the ci-node.yml at the caller's ref
 * defaults it to true, or a job whose `runs-on`, or the matrix value it reads, names a Windows runner. A
 * workflow on other events only, a job whose `if` is false, and matrix values `exclude` drops do not count.
 * False when the YAML does not parse.
 */
export async function runsOnWindows(
  text: string,
  windowsDefault: (ref: string) => Promise<boolean>,
): Promise<boolean> {
  const parsed = workflow(text);
  if (parsed === undefined) return false;
  if (!triggers(own(parsed, "on")).some((event) => CI_EVENTS.has(event)))
    return false;
  const jobs = own(parsed, "jobs");
  if (jobs === null || !isObject(jobs)) return false;
  for (const job of Object.values(jobs))
    if (
      job !== null &&
      isObject(job) &&
      (await jobRunsOnWindows(job, windowsDefault))
    )
      return true;
  return false;
}
