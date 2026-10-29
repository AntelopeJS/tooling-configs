import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  emitFingerprint,
  type EmitFingerprint,
  type EmitItem,
} from "./emit.ts";
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

const DETAIL_LIMIT = 5;
const DETAIL_LENGTH = 160;
const OUTPUT_LIMIT = 64 * 1024 * 1024;

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

function difference<Item>(
  left: Item[],
  right: Item[],
  key: (item: Item) => string,
): Item[] {
  const counts = new Map<string, number>();
  for (const item of right)
    counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return left.filter((item) => {
    const count = counts.get(key(item)) ?? 0;
    if (count === 0) return true;
    counts.set(key(item), count - 1);
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

interface Differences {
  removed: string[];
  added: string[];
}

function sequenceChanges(
  path: string,
  base: EmitItem[],
  head: EmitItem[],
): Differences {
  const length = Math.max(base.length, head.length);
  for (let index = 0; index < length; index += 1) {
    if (base[index]?.structure !== head[index]?.structure) {
      return {
        removed: [
          `${path} statement ${index + 1}: ${base[index]?.text ?? "(none)"}`,
        ],
        added: [
          `${path} statement ${index + 1}: ${head[index]?.text ?? "(none)"}`,
        ],
      };
    }
  }
  return { removed: [], added: [] };
}

function compareEmit(
  base: EmitFingerprint,
  head: EmitFingerprint,
): Differences {
  const structure = (item: EmitItem) => item.structure;
  const removed = difference(base.functions, head.functions, structure).map(
    (item) => `hoisted ${item.text}`,
  );
  const added = difference(head.functions, base.functions, structure).map(
    (item) => `hoisted ${item.text}`,
  );
  for (const path of new Set([
    ...Object.keys(base.files),
    ...Object.keys(head.files),
  ])) {
    const change = sequenceChanges(
      path,
      base.files[path] ?? [],
      head.files[path] ?? [],
    );
    removed.push(...change.removed);
    added.push(...change.added);
  }
  return { removed, added };
}

function compareProbe(base: string[], head: string[]): Differences {
  if (JSON.stringify(base) === JSON.stringify(head))
    return { removed: [], added: [] };
  const line = (item: string) => item;
  const removed = difference(base, head, line);
  const added = difference(head, base, line);
  return removed.length + added.length > 0
    ? { removed, added }
    : { removed: ["(order)"], added: ["(order)"] };
}

/**
 * Whether a diff changed the behaviour of the code a formal check covers,
 * decided without judgement. For `emit` (the default), each covered file
 * keeps its top-level statements, in order, with the same structure, and the
 * covered function declarations stay the same wherever they live; for
 * `probe`, the check's probe prints the same lines on a checkout of the base
 * and of HEAD. The check's own output never enters the decision, so a model
 * that cannot see the code still gates it.
 */
export function behaviourChange(
  repo: string,
  check: FormalCheck,
  commits: Commits,
): BehaviourChange {
  const probe =
    check.behaviour?.kind === "probe" ? check.behaviour.command : undefined;
  const change =
    probe === undefined
      ? compareEmit(
          emitFingerprint(repo, commits.baseSha, check.covers),
          emitFingerprint(repo, commits.headSha, check.covers),
        )
      : compareProbe(
          probeFingerprint(repo, probe, commits.baseSha),
          probeFingerprint(repo, probe, commits.headSha),
        );
  return {
    method: probe === undefined ? "emit" : `probe ${probe.join(" ")}`,
    changed: change.removed.length + change.added.length > 0,
    removed: sample(change.removed),
    added: sample(change.added),
  };
}
