import { parseDocument } from "yaml";

import {
  isObject,
  isString,
  parseJson,
  type JsonObject,
  type JsonValue,
} from "./json.ts";

const CI_NODE = /^AntelopeJS\/\.github\/\.github\/workflows\/ci-node\.yml@\S+$/;
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

function jobRunsOnWindows(job: JsonObject): boolean {
  const condition = own(job, "if");
  if (condition === false || (isString(condition) && NEVER.test(condition)))
    return false;
  const uses = own(job, "uses");
  if (isString(uses) && CI_NODE.test(uses)) {
    const inputs = own(job, "with");
    const windows =
      inputs !== null && isObject(inputs) ? own(inputs, "windows") : null;
    return windows === true || (isString(windows) && ALWAYS.test(windows));
  }
  return runnerIsWindows(job);
}

/**
 * Whether a workflow file runs a job on Windows for pull requests or pushes: a ci-node.yml caller with
 * `windows: true`, or a job whose `runs-on`, or the matrix value it reads, names a Windows runner. A workflow
 * on other events only, a job whose `if` is false, and matrix values `exclude` drops do not count. False when
 * the YAML does not parse.
 */
export function runsOnWindows(text: string): boolean {
  const parsed = workflow(text);
  if (parsed === undefined) return false;
  if (!triggers(own(parsed, "on")).some((event) => CI_EVENTS.has(event)))
    return false;
  const jobs = own(parsed, "jobs");
  if (jobs === null || !isObject(jobs)) return false;
  return Object.values(jobs).some(
    (job) => job !== null && isObject(job) && jobRunsOnWindows(job),
  );
}
