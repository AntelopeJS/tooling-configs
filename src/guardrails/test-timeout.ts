import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { TEST_TIMEOUT_MS } from "../test-timeout.ts";
import { workspaceDirectories } from "./docs-compat.ts";
import { parseManifest, serializeManifest } from "./package.ts";
import {
  commandParts,
  commandSteps,
  stepsOf,
  type Step,
} from "./script-steps.ts";
import type { PlannedArtifact } from "./sync.ts";

const TIMEOUT_FLAGS: Readonly<Record<TestStep["runner"], readonly string[]>> = {
  "ajs module test": ["--timeout"],
  mocha: ["--timeout", "-t"],
};

type TestStep = Extract<Step, { kind: "test" }>;

/** The value the last timeout flag of the run sets, as written, or `undefined` when no flag sets one. */
function timeoutOf(step: TestStep): string | undefined {
  const flags = TIMEOUT_FLAGS[step.runner];
  let value: string | undefined;
  step.args.forEach((arg, index) => {
    const [name, ...inline] = arg.split("=");
    if (!flags.includes(name)) return;
    value = inline.length ? inline.join("=") : step.args[index + 1];
  });
  return value;
}

/** Shell syntax sync does not rewrite flags in: substitutions, escapes and redirections. */
const UNSAFE = /[`\\<>]|\$\(/u;

const WANTED = String(TEST_TIMEOUT_MS);

/** A word of a command with where it starts and ends, as the script parser cuts it. */
interface Token {
  text: string;
  start: number;
  end: number;
}

function balanced(command: string): boolean {
  return ["'", '"'].every((quote) => command.split(quote).length % 2 === 1);
}

function edited(command: string, { start, end }: Token, text: string): string {
  return `${command.slice(0, start)}${text}${command.slice(end)}`;
}

/**
 * The command with its test run on {@link TEST_TIMEOUT_MS}. Each value of a timeout flag is set to it; a run with none gets
 * `--timeout` after its last word, or after the runner when the words after it hold {@link UNSAFE} syntax. A command that
 * runs no test, already runs on it, or that the parser may misread is returned as it is.
 */
function timedCommand(command: string): string {
  const step = commandSteps(command).find(
    (found): found is TestStep => found.kind === "test",
  );
  if (!step || timeoutOf(step) === WANTED) return command;
  if (!balanced(command) || step.args.includes("--")) return command;
  const tokens: Token[] = [...command.matchAll(/[^\s()]+/gu)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
  const first = tokens.length - step.args.length;
  const runner = tokens[first - 1];
  const aligned = tokens
    .slice(first)
    .every(
      (token, index) =>
        token.text.replace(/^["']|["']$/gu, "") === step.args[index],
    );
  if (!runner || !aligned || UNSAFE.test(command.slice(0, runner.end)))
    return command;
  const flags = TIMEOUT_FLAGS[step.runner];
  if (!step.args.some((arg) => flags.includes(arg.split("=")[0]))) {
    const { end } = UNSAFE.test(command) ? runner : tokens[tokens.length - 1];
    return edited(
      command,
      { text: "", start: end, end },
      ` --timeout ${WANTED}`,
    );
  }
  if (UNSAFE.test(command)) return command;
  let timed = command;
  for (let index = tokens.length - 1; index >= first; index--) {
    const [name, ...inline] = tokens[index].text.split("=");
    if (!flags.includes(name)) continue;
    const value = inline.length ? tokens[index] : tokens[index + 1];
    if (value === undefined) return command;
    timed = edited(timed, value, inline.length ? `${name}=${WANTED}` : WANTED);
  }
  return timed;
}

/** The script with each test run of {@link timedCommand} on the shared timeout, and every other character kept. */
export function timedScript(script: string): string {
  return commandParts(script)
    .map((part, index) => (index % 2 ? part : timedCommand(part)))
    .join("");
}

/** The manifest text with its scripts' test runs on the shared timeout, or `current` itself when none changes. */
export function timedManifest(current: string): string {
  const manifest = parseManifest(current);
  const scripts = Object.entries(manifest.scripts ?? {});
  const timed = scripts.map(([name, text]) => [name, timedScript(text)]);
  if (timed.every(([, text], index) => text === scripts[index][1]))
    return current;
  manifest.scripts = Object.fromEntries(timed);
  return serializeManifest(manifest, current);
}

/** The writes that put the test runs of the workspace members' scripts on the shared timeout; the root package.json is planned with the other managed artifacts. */
export function testTimeoutArtifacts(root: string): PlannedArtifact[] {
  return workspaceDirectories(root).flatMap((directory): PlannedArtifact[] => {
    const path = `${directory}/package.json`;
    const current = readFileSync(join(root, path), "utf8");
    let content: string;
    try {
      content = timedManifest(current);
    } catch {
      return [];
    }
    return content === current
      ? []
      : [{ kind: "write", path, content, mode: undefined }];
  });
}

function finding(
  manifest: string,
  script: string,
  step: TestStep,
): string | undefined {
  const timeout = timeoutOf(step);
  if (timeout === WANTED) return undefined;
  const where = `${manifest} script "${script}" runs ${step.runner}`;
  return timeout === undefined
    ? `${where} without --timeout, so it runs on mocha's 2000 ms default or a .mocharc limit; add --timeout ${WANTED}, the shared CI test timeout.`
    : `${where} with its own --timeout ${timeout}; set --timeout ${WANTED}, the shared CI test timeout.`;
}

function manifestFindings(root: string, directory: string): string[] {
  const manifest = directory ? `${directory}/package.json` : "package.json";
  const path = join(root, manifest);
  if (!existsSync(path)) return [];
  let scripts: Record<string, string>;
  try {
    scripts = parseManifest(readFileSync(path, "utf8")).scripts ?? {};
  } catch {
    return [];
  }
  return Object.entries(scripts).flatMap(([script, text]) =>
    stepsOf(text).flatMap((step) => {
      if (step.kind !== "test") return [];
      const found = finding(manifest, script, step);
      return found === undefined ? [] : [found];
    }),
  );
}

/** Every `ajs module test` and `mocha` run in the scripts of the root package and the workspace members must pass `--timeout` with the shared {@link TEST_TIMEOUT_MS}. Under `check` a run without it is an error; otherwise it is a `Note:` advisory. */
export function checkTestTimeouts(root: string, check: boolean) {
  if (!existsSync(join(root, "package.json")))
    return { errors: [], advisories: [] };
  const findings = ["", ...workspaceDirectories(root)].flatMap((directory) =>
    manifestFindings(root, directory),
  );
  return {
    errors: check ? findings : [],
    advisories: check ? [] : findings.map((note) => `Note: ${note}`),
  };
}
