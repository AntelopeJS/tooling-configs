import { createHash } from "node:crypto";

import { resolveRevision } from "./files.ts";

const PROOF_STAMP =
  /^<!-- antelopejs-proof base=([0-9a-f]{40}) head=([0-9a-f]{40}) lines=(\d+) digest=([0-9a-f]{16}) command: (.+) -->$/u;

/** The revisions and command a proof bin stamps under its output, so a pasted copy can be traced and recomputed. */
export interface ProofStamp {
  base: string;
  head: string;
  /** How many digested lines, counted by `proofLines`, precede the stamp. */
  lines: number;
  digest: string;
  command: string;
}

function tableRow(line: string): string {
  const cells = line
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((cell) => cell.trim())
    .map((cell) =>
      /^:?-+:?$/u.test(cell) ? cell.replace(/-+/u, "---") : cell,
    );
  return `| ${cells.join(" | ")} |`;
}

/** The lines a digest covers: trimmed, blank lines and code fences dropped, table cells re-padded, so indenting or reformatting a copy keeps it valid. */
export function proofLines(lines: readonly string[]): string[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("```"))
    .map((line) => (line.startsWith("|") ? tableRow(line) : line));
}

/** Hashes the stamp's revisions and command with the normalised output lines. */
export function proofDigest(
  stamp: Omit<ProofStamp, "digest" | "lines">,
  lines: readonly string[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        stamp.command,
        stamp.base,
        stamp.head,
        ...proofLines(lines),
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}

/** Reads a stamp line, or `undefined` when the line is not one. */
export function parseProofStamp(line: string): ProofStamp | undefined {
  const match = PROOF_STAMP.exec(line.trim());
  if (!match) return undefined;
  const [, base, head, lines, digest, command] = match;
  return { base, head, lines: Number(lines), digest, command };
}

/** Appends a stamp line to a proof bin's output: the base and committed head it compared, the command, how many lines it printed, and a digest of them. */
export function stampProof(
  root: string,
  command: string,
  baseRef: string,
  output: string,
): string {
  const stamp = {
    base: resolveRevision(root, baseRef),
    head: resolveRevision(root, "HEAD"),
    command,
  };
  const text = output.endsWith("\n") ? output : `${output}\n`;
  const lines = text.split("\n");
  return `${text}<!-- antelopejs-proof base=${stamp.base} head=${stamp.head} lines=${proofLines(lines).length} digest=${proofDigest(stamp, lines)} command: ${command} -->\n`;
}
