import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import ts from "typescript";

import type { FormalCheck } from "./types.ts";
import { git } from "./workspace.ts";

/** The base and head commits a formal check compares. */
export interface Commits {
  baseSha: string;
  headSha: string;
}

/** Whether a diff changed what the covered code does, how it was decided, and a sample of what differs. */
export interface BehaviourChange {
  method: string;
  changed: boolean;
  removed: string[];
  added: string[];
}

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
]);
const DETAIL_LIMIT = 5;
const DETAIL_LENGTH = 160;
const OUTPUT_LIMIT = 64 * 1024 * 1024;

function fileAt(repo: string, sha: string, path: string): string | null {
  const shown = spawnSync("git", ["show", `${sha}:${path}`], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: OUTPUT_LIMIT,
  });
  return shown.status === 0 ? shown.stdout : null;
}

function scriptStatements(path: string, source: string): string[] {
  const { outputText } = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      removeComments: true,
      experimentalDecorators: true,
    },
  });
  const file = ts.createSourceFile(
    "emit.js",
    outputText,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  );
  const printer = ts.createPrinter({ removeComments: true });
  return file.statements
    .filter((statement) => !ts.isImportDeclaration(statement))
    .filter(
      (statement) =>
        !(ts.isExportDeclaration(statement) && statement.moduleSpecifier),
    )
    .map((statement) =>
      printer
        .printNode(ts.EmitHint.Unspecified, statement, file)
        .replace(/^export (default )?/, ""),
    );
}

function statementsOf(path: string, source: string): string[] {
  if (CODE_EXTENSIONS.has(extname(path))) return scriptStatements(path, source);
  return [`file ${source.replace(/\s+/g, " ").trim()}`];
}

/**
 * What the covered code does at a commit, as the sorted top-level statements
 * of its JavaScript: types, comments, formatting, imports, re-exports and
 * `export` keywords left out, so a type-only edit, a comment or a verbatim
 * move between covered files keeps the same fingerprint.
 */
function emitFingerprint(repo: string, sha: string, files: string[]): string[] {
  return files
    .flatMap((path) => {
      const source = fileAt(repo, sha, path);
      return source === null ? [] : statementsOf(path, source);
    })
    .sort((left, right) => left.localeCompare(right));
}

/** Runs `action` in a throwaway worktree of `sha` whose `node_modules` links the checkout's, then removes it. */
export function inWorktree<Result>(
  repo: string,
  sha: string,
  action: (dir: string) => Result,
): Result {
  const dir = mkdtempSync(join(tmpdir(), "antelopejs-verify-behaviour-"));
  git(repo, ["worktree", "add", "--quiet", "--detach", "--force", dir, sha]);
  try {
    symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"), "dir");
    return action(dir);
  } finally {
    git(repo, ["worktree", "remove", "--force", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
}

function probeFingerprint(
  repo: string,
  command: string[],
  sha: string,
): string[] {
  const [program, ...args] = command;
  return inWorktree(repo, sha, (dir) => {
    const run = spawnSync(program, [...args, dir], {
      cwd: repo,
      encoding: "utf8",
      maxBuffer: OUTPUT_LIMIT,
    });
    if (run.status !== 0)
      throw new Error(
        `behaviour probe ${command.join(" ")} failed on ${sha}:\n${run.stderr}`,
      );
    return run.stdout.split("\n").filter(Boolean);
  });
}

function difference(left: string[], right: string[]): string[] {
  const counts = new Map<string, number>();
  for (const item of right) counts.set(item, (counts.get(item) ?? 0) + 1);
  return left.filter((item) => {
    const count = counts.get(item) ?? 0;
    if (count === 0) return true;
    counts.set(item, count - 1);
    return false;
  });
}

function sample(lines: string[]): string[] {
  return lines
    .slice(0, DETAIL_LIMIT)
    .map((line) =>
      line.length > DETAIL_LENGTH ? `${line.slice(0, DETAIL_LENGTH)}…` : line,
    );
}

/**
 * Whether a diff changed the behaviour of the code a formal check covers,
 * decided without judgement: the check's `behaviour` probe prints the same
 * lines on the base and on HEAD, or, for `emit` (the default), the covered
 * files keep the same JavaScript statements. The check's own output never
 * enters the decision, so a model that cannot see the code still gates it.
 */
export function behaviourChange(
  repo: string,
  check: FormalCheck,
  commits: Commits,
): BehaviourChange {
  const probe =
    check.behaviour?.kind === "probe" ? check.behaviour.command : undefined;
  const fingerprint = (sha: string) =>
    probe === undefined
      ? emitFingerprint(repo, sha, check.covers)
      : probeFingerprint(repo, probe, sha);
  const base = fingerprint(commits.baseSha);
  const head = fingerprint(commits.headSha);
  const removed = difference(base, head);
  const added = difference(head, base);
  return {
    method: probe === undefined ? "emit" : `probe ${probe.join(" ")}`,
    changed: removed.length + added.length > 0,
    removed: sample(removed),
    added: sample(added),
  };
}
