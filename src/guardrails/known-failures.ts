import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type JsonValue, isObject, optStr, parseJson } from "../garden/json.ts";

/** The file at the repository root that declares the errors `published:types` reports in a dependency's own declarations. */
export const KNOWN_FAILURES_FILE = "guardrails.published-types.json";

/** An error tsc reports in the declarations of a dependency the repository does not publish: the package, the file inside it, and the code, such as `TS2416`. */
export interface KnownFailure {
  dependency: string;
  file: string;
  code: string;
}

const ENTRY_KEYS = new Set(["dependency", "file", "code"]);
const CODE = /^TS\d+$/;
const INSIDE_PACKAGE = /^(?!\.\/|\/)[^\\]+$/;
const PACKAGE_NAME = /^(?:@[^/\s]+\/)?[^/@\s][^/\s]*$/;

/** What is wrong with `entry`, or the {@link KnownFailure} it declares. */
function parseEntry(
  entry: JsonValue,
): { problem: string } | { problem: ""; failure: KnownFailure } {
  if (!isObject(entry)) return { problem: "is not an object" };
  const extra = Object.keys(entry).filter((key) => !ENTRY_KEYS.has(key));
  if (extra.length) return { problem: `has unknown key ${extra.join(", ")}` };
  const dependency = optStr(entry, "dependency") ?? "";
  const file = optStr(entry, "file") ?? "";
  const code = optStr(entry, "code") ?? "";
  if (!PACKAGE_NAME.test(dependency))
    return { problem: "needs dependency as a package name" };
  if (!INSIDE_PACKAGE.test(file) || file.split("/").includes(".."))
    return { problem: "needs file as a path inside the package" };
  if (!CODE.test(code)) return { problem: "needs code such as TS2416" };
  return { problem: "", failure: { dependency, file, code } };
}

const EXPECTED = `expected { "knownFailures": [{ "dependency", "file", "code" }] }`;

/** The entries `KNOWN_FAILURES_FILE` declares at `root`, none when the file is missing, or what is wrong with it. An entry may not name a package of `ownPackages`, the repository's own, whose declarations the repository fixes instead. */
export function readKnownFailures(
  root: string,
  ownPackages: ReadonlySet<string>,
): { failure: string } | { failure: ""; entries: KnownFailure[] } {
  const path = join(root, KNOWN_FAILURES_FILE);
  if (!existsSync(path)) return { failure: "", entries: [] };
  let parsed: JsonValue;
  try {
    parsed = parseJson(readFileSync(path, "utf8"));
  } catch (error) {
    return { failure: `${KNOWN_FAILURES_FILE}: ${String(error)}\n` };
  }
  const list =
    isObject(parsed) &&
    Object.keys(parsed).length === 1 &&
    Object.hasOwn(parsed, "knownFailures")
      ? parsed.knownFailures
      : undefined;
  if (!Array.isArray(list))
    return { failure: `${KNOWN_FAILURES_FILE}: ${EXPECTED}.\n` };
  const entries: KnownFailure[] = [];
  let problems = "";
  for (const [index, value] of list.entries()) {
    const parsedEntry = parseEntry(value);
    const duplicate =
      "failure" in parsedEntry &&
      entries.some(
        (entry) => describeEntry(entry) === describeEntry(parsedEntry.failure),
      );
    if (duplicate)
      problems += `${KNOWN_FAILURES_FILE}: knownFailures[${index}] repeats an earlier entry.\n`;
    else if (
      "failure" in parsedEntry &&
      ownPackages.has(parsedEntry.failure.dependency)
    )
      problems += `${KNOWN_FAILURES_FILE}: knownFailures[${index}] names ${parsedEntry.failure.dependency}, a package of this repository. Fix its declarations instead.\n`;
    else if ("failure" in parsedEntry) entries.push(parsedEntry.failure);
    else
      problems += `${KNOWN_FAILURES_FILE}: knownFailures[${index}] ${parsedEntry.problem}.\n`;
  }
  return problems ? { failure: problems } : { failure: "", entries };
}

/** The diagnostics of tsc's `--pretty false` output, each its first line and the indented lines that continue it. */
function diagnosticBlocks(output: string): string[] {
  const blocks: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    if (/^\s/.test(line) && blocks.length)
      blocks[blocks.length - 1] += `\n${line}`;
    else blocks.push(line);
  }
  return blocks;
}

const LOCATED = /^(.*?)\(\d+,\d+\): error (TS\d+): /;
const INSTALLED = /^((?:@[^/]+\/)?[^/]+)\/(.+)$/;
const NODE_MODULES = "node_modules/";

/** A diagnostic tsc reports in a file under `node_modules`: the installed package, the file inside it, the code, and the diagnostic with its path cut to `<package>/<file>`. */
interface InstalledDiagnostic extends KnownFailure {
  text: string;
}

/** Where `block` is reported, undefined when it names no file under `node_modules`. */
function installedDiagnostic(block: string): InstalledDiagnostic | undefined {
  const [, path = "", code = ""] = LOCATED.exec(block) ?? [];
  const marker = path.lastIndexOf(NODE_MODULES);
  if (marker < 0) return undefined;
  const installed = path.slice(marker + NODE_MODULES.length);
  const [, dependency = "", file = ""] = INSTALLED.exec(installed) ?? [];
  if (!dependency) return undefined;
  return {
    dependency,
    file,
    code,
    text: `${installed}${block.slice(path.length)}`,
  };
}

/** `entry` written as tsc names its file, `<dependency>/<file> <code>`. */
export function describeEntry(entry: KnownFailure): string {
  return `${entry.dependency}/${entry.file} ${entry.code}`;
}

/**
 * Splits tsc's `--pretty false` `output` into the diagnostics an entry of `entries` declares and the rest. A diagnostic
 * is declared when it lies in a package's installed declarations and an entry names that package, the file inside it
 * and the code. Each entry that declares one is added to `matched`. A diagnostic in a
 * file under `node_modules` names it as `<package>/<file>`.
 */
export function splitDiagnostics(
  output: string,
  entries: readonly KnownFailure[],
  matched: Set<KnownFailure>,
) {
  const known: string[] = [];
  const unknown: string[] = [];
  for (const block of diagnosticBlocks(output)) {
    const diagnostic = installedDiagnostic(block);
    const entry = diagnostic
      ? entries.find(
          ({ dependency, file, code }) =>
            dependency === diagnostic.dependency &&
            file === diagnostic.file &&
            code === diagnostic.code,
        )
      : undefined;
    if (entry && diagnostic) {
      matched.add(entry);
      known.push(diagnostic.text);
    } else unknown.push(diagnostic?.text ?? block);
  }
  return { known, unknown };
}
