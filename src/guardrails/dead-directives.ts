import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, posix } from "node:path";

import { changedFiles } from "./files.ts";
import {
  directiveReport,
  typeAwareRules,
  type UnusedDirective,
  type UntypedConfig,
} from "./oxlint.ts";
import {
  inWorktree,
  suppressionsIn,
  type Suppression,
} from "./suppressions.ts";

/** One lint directive comment: the rules it names (`*` for none) and where it starts. */
interface Directive {
  file: string;
  line: number;
  directive: string;
  rules: string[];
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
  };
}

function written(directive: Directive, rules = directive.rules): string {
  const named = rules.filter((rule) => rule !== "*");
  return `\`${[directive.directive, ...(named.length ? [named.join(", ")] : [])].join(" ")}\``;
}

/** Whether an ESLint config sits in the file's directory or above it, so ESLint may run the rules an `eslint-` directive names. */
function lintedByEslint(root: string, file: string): boolean {
  for (
    let directory = posix.dirname(file);
    ;
    directory = posix.dirname(directory)
  ) {
    if (
      readdirSync(join(root, directory)).some((name) =>
        ESLINT_CONFIG.test(name),
      )
    )
      return true;
    if (directory === ".") return false;
  }
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

/** The tsconfig, among those oxlint cannot load, whose directory holds `file`. */
function untypedConfig(
  untyped: UntypedConfig[],
  file: string,
): UntypedConfig | undefined {
  return untyped.find(({ tsconfig }) => {
    const directory = posix.dirname(tsconfig);
    return directory === "." || file.startsWith(`${directory}/`);
  });
}

/**
 * Removes from `dead` the rules oxlint could not have run on their file: a
 * type-aware rule, or any rule for a directive naming none, under a tsconfig
 * oxlint cannot load. Returns one note per such tsconfig naming the
 * directives left unjudged.
 */
function withoutUntyped(
  root: string,
  untyped: UntypedConfig[],
  dead: Map<Directive, Set<string>>,
): string[] {
  if (untyped.length === 0) return [];
  const typeAware = typeAwareRules(root);
  const unjudged = new Map<UntypedConfig, string[]>();
  for (const [directive, rules] of dead) {
    const config = untypedConfig(untyped, directive.file);
    if (config === undefined) continue;
    const skipped = [...rules].filter(
      (rule) => rule === "*" || typeAware.has(rule),
    );
    if (skipped.length === 0) continue;
    for (const rule of skipped) rules.delete(rule);
    if (rules.size === 0) dead.delete(directive);
    unjudged.set(config, [
      ...(unjudged.get(config) ?? []),
      `${directive.file}:${directive.line} ${written(directive, skipped)}`,
    ]);
  }
  return [...unjudged].map(
    ([{ tsconfig, reason }, listed]) =>
      `${tsconfig} cannot load (${reason}), so oxlint ran no type-aware rule on the files under it. Not judged: ${listed.join(", ")}.`,
  );
}

/** What the dead-directive check found: the failures, and notes on what it could not judge. */
export interface DeadDirectiveReport {
  failures: string[];
  notes: string[];
}

/**
 * Fails, in each of `files`, every lint directive that suppresses nothing
 * under the repository's own lint configuration. Directives in other files
 * are left alone, so adopting the check changes no existing file until a
 * change touches it. `eslint-` directives under an ESLint config
 * are left to ESLint, and `.vue` files are not linted by oxlint. Under a
 * tsconfig oxlint cannot load, the directives for rules that need type
 * information are not judged, and a note says so.
 */
export function deadDirectiveReport(
  root: string,
  files: string[],
): DeadDirectiveReport {
  const directives = inWorktree(root, directivesIn, files);
  const readByOxlint = directives.filter(
    ({ file, directive }) =>
      !file.endsWith(".vue") &&
      !(directive.startsWith("eslint-") && lintedByEslint(root, file)),
  );
  const lintable = [...new Set(readByOxlint.map(({ file }) => file))];
  const { unused, unreadable, untyped } = lintable.length
    ? directiveReport(root, lintable)
    : { unused: [], unreadable: [], untyped: [] };
  const dead = new Map<Directive, Set<string>>();
  const unplaced = unreadable.map(
    ({ location, message }) =>
      `${location === undefined ? "" : `${location}: `}oxlint cannot check the directives here: ${message}. Fix: correct the file so oxlint reads it without errors, then rerun the check.`,
  );
  for (const item of unused) {
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
  const notes = withoutUntyped(root, untyped, dead);
  return {
    failures: [
      ...unplaced,
      ...directives.flatMap((directive) => {
        const rules = dead.get(directive);
        return rules === undefined ? [] : deadFailure(directive, rules);
      }),
    ],
    notes,
  };
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
