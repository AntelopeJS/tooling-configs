import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { changedFiles } from "./files.ts";
import { unusedDirectives, type UnusedDirective } from "./oxlint.ts";
import {
  inWorktree,
  suppressionsIn,
  type Suppression,
} from "./suppressions.ts";

/** One lint directive comment: the rules it names (`*` for none), the reason it gives, and where it starts. */
interface Directive {
  file: string;
  line: number;
  directive: string;
  rules: string[];
  reason: string;
}

const BLOCK_DISABLE = /-disable$/u;
const ESLINT_CONFIG = /^(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\..+)?)$/u;

function directivesIn(file: string, text: string): Directive[] {
  const grouped = new Map<string, Directive>();
  for (const found of suppressionsIn(file, text)) {
    if (found.kind !== "rule") continue;
    const key = `${found.line}\0${found.directive}`;
    const known = grouped.get(key);
    if (known === undefined) grouped.set(key, entry(found));
    else known.rules.push(found.rule);
  }
  return [...grouped.values()];
}

function entry(found: Extract<Suppression, { kind: "rule" }>): Directive {
  return {
    file: found.file,
    line: found.line,
    directive: found.directive,
    rules: [found.rule],
    reason: found.reason,
  };
}

function written(directive: Directive, rules = directive.rules): string {
  const named = rules.filter((rule) => rule !== "*");
  return `\`${[directive.directive, ...(named.length ? [named.join(", ")] : [])].join(" ")}\``;
}

/** Whether an ESLint config sits in the file's directory or above it, so ESLint may run the rules an `eslint-` directive names. */
function lintedByEslint(root: string, file: string): boolean {
  for (
    let directory = dirname(join(root, file));
    directory.startsWith(root);
    directory = dirname(directory)
  ) {
    if (readdirSync(directory).some((name) => ESLINT_CONFIG.test(name)))
      return true;
    if (directory === root) break;
  }
  return false;
}

/** The directive oxlint's report is about: on its line, else the nearest earlier block disable it ends at an `-enable` on that line, naming the dead rule when oxlint names one. */
function reported(
  directives: Directive[],
  unused: UnusedDirective,
): Directive | undefined {
  const named = (directive: Directive) =>
    unused.rules === undefined ||
    unused.rules.every((rule) => directive.rules.includes(rule));
  const here = directives.filter(
    (directive) =>
      directive.file === unused.file &&
      directive.line === unused.line &&
      named(directive),
  );
  if (here.length) return here[0];
  return directives
    .filter(
      (directive) =>
        directive.file === unused.file &&
        directive.line < unused.line &&
        BLOCK_DISABLE.test(directive.directive) &&
        named(directive),
    )
    .at(-1);
}

function deadFailure(directive: Directive, dead: Set<string>): string[] {
  const at = `${directive.file}:${directive.line}`;
  if (directive.rules.every((rule) => dead.has(rule)))
    return [
      `${at}: ${written(directive)} suppresses nothing. Fix: delete the directive.`,
    ];
  const closing = BLOCK_DISABLE.test(directive.directive)
    ? " and from its enable"
    : "";
  return [...dead].map(
    (rule) =>
      `${at}: ${written(directive, [rule])} suppresses nothing. Fix: drop \`${rule}\` from the directive${closing}.`,
  );
}

function reasonlessFailure(directive: Directive): string[] {
  if (directive.reason !== "" || directive.rules.includes("*")) return [];
  return [
    `${directive.file}:${directive.line}: ${written(directive)} gives no reason. Fix: add \` -- <why this line needs it>\` after the rules, or delete the directive.`,
  ];
}

/**
 * Fails, in each of `files`, every lint directive that suppresses nothing
 * under the repository's own lint configuration with its ratchet rules
 * enabled, and every directive naming rules that gives no reason. Directives
 * in other files are left alone, so adopting the check changes no existing
 * file until a change touches it. `eslint-` directives under an ESLint config
 * are left to ESLint, and `.vue` files are not linted by oxlint.
 */
export function deadDirectiveFailures(root: string, files: string[]): string[] {
  const directives = inWorktree(root, directivesIn, files);
  const readByOxlint = directives.filter(
    ({ file, directive }) =>
      !file.endsWith(".vue") &&
      !(directive.startsWith("eslint-") && lintedByEslint(root, file)),
  );
  const lintable = [...new Set(readByOxlint.map(({ file }) => file))];
  const dead = new Map<Directive, Set<string>>();
  const unplaced: string[] = [];
  for (const item of lintable.length ? unusedDirectives(root, lintable) : []) {
    const directive = reported(readByOxlint, item);
    if (directive === undefined) {
      unplaced.push(
        `${item.file}:${item.line}: ${item.message} Fix: delete the directive.`,
      );
      continue;
    }
    const rules = dead.get(directive) ?? new Set<string>();
    for (const rule of item.rules ?? directive.rules) rules.add(rule);
    dead.set(directive, rules);
  }
  return [
    ...unplaced,
    ...directives.flatMap((directive) => {
      const rules = dead.get(directive);
      return rules === undefined
        ? reasonlessFailure(directive)
        : deadFailure(directive, rules);
    }),
  ];
}

function mergeBase(root: string, revision: string): string {
  const result = spawnSync("git", ["merge-base", revision, "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : revision;
}

/**
 * The files a pull request changes: the working tree against the merge-base
 * of `revision` and HEAD (`revision` itself when they have none, as in a
 * shallow checkout), untracked files included; against HEAD without one.
 */
export function touchedFiles(root: string, revision?: string): string[] {
  if (revision === undefined) return [...changedFiles(root)];
  const tracked = execFileSync(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", mergeBase(root, revision)],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return [...new Set([...tracked.split("\0"), ...changedFiles(root)])].filter(
    Boolean,
  );
}
