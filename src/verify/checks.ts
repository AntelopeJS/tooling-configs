import { existsSync, readFileSync } from "node:fs";

import { isObject, type JsonValue } from "../garden/json.ts";
import type { Check, HttpResult } from "./types.ts";

interface Exited {
  exitCode: number | null;
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

/** The process exited with `code`. */
export function exitIs(result: Exited, code: number): Check {
  return {
    name: `exit code ${code}`,
    pass: result.exitCode === code,
    detail: `exit code ${result.exitCode}`,
  };
}

/** The process ended on SIGINT, by exit code 130 or by the signal itself. */
export function interrupted(result: {
  exitCode: number | null;
  signal: string | null;
}): Check {
  return {
    name: "ended by SIGINT (exit 130)",
    pass: result.exitCode === 130 || result.signal === "SIGINT",
    detail: `exit code ${result.exitCode}, signal ${result.signal}`,
  };
}

/** `text` matches `pattern`; `label` names the stream. */
export function has(label: string, text: string, pattern: RegExp): Check {
  return {
    name: `${label} matches ${pattern}`,
    pass: pattern.test(text),
    detail: excerpt(text),
  };
}

/** `text` does not match `pattern`. */
export function lacks(label: string, text: string, pattern: RegExp): Check {
  return {
    name: `${label} does not match ${pattern}`,
    pass: !pattern.test(text),
    detail: excerpt(text),
  };
}

/** A file or folder exists at `file`. */
export function exists(file: string): Check {
  const present = existsSync(file);
  return {
    name: `${file} exists`,
    pass: present,
    detail: present ? "present" : "missing",
  };
}

/** The file at `file` matches `pattern`. */
export function fileHas(file: string, pattern: RegExp): Check {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  return {
    name: `${file} matches ${pattern}`,
    pass: pattern.test(text),
    detail: excerpt(text),
  };
}

/** Two values are deeply equal once serialized. */
export function equal(
  name: string,
  actual: JsonValue | undefined,
  expected: JsonValue,
): Check {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  return {
    name,
    pass: left === right,
    detail: `expected ${right}, got ${left}`,
  };
}

/** The request answered `status` (200 by default). */
export function answered(result: HttpResult, status = 200): Check {
  return {
    name: `${result.url} answers ${status}`,
    pass: result.status === status,
    detail:
      result.error ?? `status ${result.status}, body ${excerpt(result.body)}`,
  };
}

/** The request answered 200 with JSON whose `key` is `expected`. */
export function answers(
  result: HttpResult,
  key: string,
  expected: JsonValue,
): Check {
  const actual =
    result.json !== undefined && isObject(result.json)
      ? result.json[key]
      : undefined;
  return {
    name: `${result.url} answers 200 with ${key} ${JSON.stringify(expected)}`,
    pass:
      result.status === 200 &&
      JSON.stringify(actual) === JSON.stringify(expected),
    detail:
      result.error ?? `status ${result.status}, body ${excerpt(result.body)}`,
  };
}

/** Nothing answered the request. */
export function refused(result: HttpResult): Check {
  return {
    name: `${result.url} is refused`,
    pass: result.status === null,
    detail: result.error ?? `status ${result.status}`,
  };
}
