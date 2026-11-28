import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

import { workspaceDirectories } from "./docs-compat.ts";
import { parseManifest } from "./package.ts";

/** A package script a `pnpm` command in a script runs: in the package itself, or in the workspace packages it targets. */
type PnpmRun =
  | { kind: "own"; script: string }
  | { kind: "packages"; script: string; targets: Target[] };

type Target = { all: true } | { directory: string } | { name: string };

const VALUE_FLAGS = new Set(["--dir", "-C", "--filter", "-F"]);
const BUILTINS = new Set(
  "add audit create dlx exec fetch i import init install link list ls outdated pack prune publish rebuild remove rm store unlink up update why x".split(
    " ",
  ),
);

function commands(script: string): string[][] {
  return script
    .split(/&&|\|\||[;&|]/)
    .map((command) =>
      command
        .replace(/^[\s(]+|[\s)]+$/g, "")
        .split(/\s+/)
        .filter((word) => word && !/^\w+=/.test(word)),
    )
    .filter((words) => words.length > 0);
}

function flagValue(words: string[], at: number): [string, string, number] {
  const [flag, value] = words[at].split("=", 2);
  if (value !== undefined) return [flag, value, at];
  return [flag, words[at + 1] ?? "", at + 1];
}

function target(base: string, selector: string, directory: boolean): Target {
  const path = selector.replace(/^\{(.*)\}$/, "$1");
  if (directory || path.startsWith("."))
    return { directory: posix.join(base, path).replace(/^\.$/, "") };
  return { name: selector };
}

/** The package script a `pnpm` command runs, or `undefined` for any other command, such as `pnpm install` or `node --test`. */
function pnpmRun(words: string[], base: string): PnpmRun | undefined {
  if (words[0] !== "pnpm") return undefined;
  const targets: Target[] = [];
  const positionals: string[] = [];
  let recursive = false;
  for (let at = 1; at < words.length; at++) {
    const word = words[at];
    if (word === "-r" || word === "--recursive") recursive = true;
    else if (VALUE_FLAGS.has(word.split("=")[0])) {
      const [flag, value, next] = flagValue(words, at);
      at = next;
      targets.push(target(base, value, flag === "--dir" || flag === "-C"));
    } else if (!word.startsWith("-")) positionals.push(word);
  }
  const [command, script] = positionals;
  if (command === undefined || BUILTINS.has(command)) return undefined;
  const name = command === "run" ? script : command === "t" ? "test" : command;
  if (name === undefined) return undefined;
  if (recursive && !targets.length) targets.push({ all: true });
  const own = targets.every(
    (item) => "directory" in item && item.directory === base,
  );
  return own
    ? { kind: "own", script: name }
    : { kind: "packages", script: name, targets };
}

/**
 * Whether ci-node.yml's `affected-tests` input fits the repository at `root`.
 * A single package fits: ci-node.yml narrows a lone vitest or jest command and runs any other `test` script whole.
 * A workspace fits when its suite is made of the packages' own `test` scripts, since ci-node.yml then runs the `test`
 * script of each changed package and its dependents: the root `test` script runs package `test` scripts, through
 * `pnpm -r`, `--dir` or `--filter`, its own scripts and those package scripts in turn, and reaches every package that
 * has a `test` script. A package script the suite runs under another name, such as `test:layer`, reaches nothing.
 */
export function affectedTestsFit(root: string): boolean {
  if (!existsSync(join(root, "package.json"))) return false;
  const members = workspaceDirectories(root);
  if (!members.length) return true;
  const manifests = new Map(
    ["", ...members].map((directory) => [
      directory,
      parseManifest(
        readFileSync(join(root, directory, "package.json"), "utf8"),
      ),
    ]),
  );
  const named = (name: string): string[] | undefined => {
    const found = members.filter(
      (directory) => manifests.get(directory)?.name === name,
    );
    return found.length ? found : undefined;
  };
  const resolve = (item: Target): string[] | undefined =>
    "all" in item
      ? members
      : "name" in item
        ? named(item.name)
        : manifests.has(item.directory)
          ? [item.directory]
          : undefined;
  const covered = new Set<string>();
  const seen = new Set<string>();
  const visit = (directory: string, script: string): boolean => {
    const scripts = manifests.get(directory)?.scripts;
    const text =
      scripts && Object.hasOwn(scripts, script) ? scripts[script] : undefined;
    if (text === undefined || seen.has(`${directory}\0${script}`)) return true;
    seen.add(`${directory}\0${script}`);
    return commands(text).every((words) => {
      const run = pnpmRun(words, directory);
      if (run === undefined) return true;
      if (run.kind === "own") return visit(directory, run.script);
      if (run.script !== "test") return true;
      return run.targets.every((item) => {
        const found = resolve(item);
        if (found === undefined) return false;
        for (const member of found) covered.add(member);
        return found.every((member) => visit(member, "test"));
      });
    });
  };
  return (
    visit("", "test") &&
    covered.size > 0 &&
    members.every(
      (directory) =>
        manifests.get(directory)?.scripts?.test === undefined ||
        covered.has(directory),
    )
  );
}
