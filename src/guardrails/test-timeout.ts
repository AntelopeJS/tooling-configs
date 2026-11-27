import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { TEST_TIMEOUT_MS } from "../test-timeout.ts";
import { workspaceDirectories } from "./docs-compat.ts";
import { parseManifest } from "./package.ts";
import { stepsOf, type Step } from "./script-steps.ts";

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

function finding(
  manifest: string,
  script: string,
  step: TestStep,
): string | undefined {
  const timeout = timeoutOf(step);
  const wanted = String(TEST_TIMEOUT_MS);
  if (timeout === wanted) return undefined;
  const where = `${manifest} script "${script}" runs ${step.runner}`;
  return timeout === undefined
    ? `${where} on mocha's 2000 ms default timeout; add --timeout ${wanted}, the shared CI test timeout.`
    : `${where} with its own --timeout ${timeout}; set --timeout ${wanted}, the shared CI test timeout.`;
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
