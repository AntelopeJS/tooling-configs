import { spawnSync } from "node:child_process";

import { findingsProblems, formatFindings } from "./body-findings.ts";
import {
  CODE_MENTION,
  scanBody,
  type BodyBlock,
  type BodyLine,
} from "./body-scan.ts";
import { lintDiagnostics, type Diagnostic } from "./oxlint.ts";
import { proofDigest } from "./proof-stamp.ts";
import { revisionCountRows } from "./revisions.ts";

const PROOF_COMMANDS =
  "`antelopejs-api-diff <base-ref>` or `antelopejs-comment-proof <base-ref>`";
const SUPPRESSION_HEADER = /^\|\s*Suppressions\s*\|\s*base\s*\|\s*HEAD\s*\|/u;
const PROOF_SUMMARY =
  /\b(?:Runtime API|API|Comment proof): (?:\d+ packages, \d+ entries unchanged|differences|comparison incomplete)/u;

function git(root: string, args: string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return { ok: result.status === 0, out: result.stdout.trim() };
}

function outsideProblems(lines: BodyLine[]): string[] {
  return lines.flatMap((line) => {
    const text = line.text.trim();
    if (SUPPRESSION_HEADER.test(text))
      return [
        `line ${line.number}: suppression table outside a stamped proof block. Copy the whole output of ${PROOF_COMMANDS}, its closing antelopejs-proof stamp included.`,
      ];
    if (PROOF_SUMMARY.test(text))
      return [
        `line ${line.number}: proof output outside a stamped proof block. Copy the whole output of ${PROOF_COMMANDS}, its closing antelopejs-proof stamp included.`,
      ];
    const reference = line.inFindingsSection ? CODE_MENTION.exec(text) : null;
    return reference
      ? [
          `line ${line.number}: \`${reference[0]}\` sits in a findings-left section outside an antelopejs-findings block. Print the list with \`antelopejs-body-check --findings\`, copy its block, and give each finding its reason.`,
        ]
      : [];
  });
}

function tableRows(lines: BodyLine[]): Map<string, string> {
  const rows = new Map<string, string>();
  for (const { text } of lines) {
    const cells = text
      .trim()
      .replace(/^\|/u, "")
      .replace(/\|$/u, "")
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length === 3 && /^\d+$/u.test(cells[1]))
      rows.set(cells[0], `${cells[1]} | ${cells[2]}`);
  }
  return rows;
}

function suppressionProblems(root: string, block: BodyBlock, rerun: string) {
  if (!block.lines.some(({ text }) => SUPPRESSION_HEADER.test(text.trim())))
    return [];
  const base = block.stamp?.base ?? "HEAD";
  const copied = tableRows(block.lines);
  const current = tableRows(
    revisionCountRows(root, base).map((text) => ({
      number: 0,
      text,
      inFindingsSection: false,
    })),
  );
  return [...new Set([...copied.keys(), ...current.keys()])].flatMap((label) =>
    copied.get(label) === current.get(label)
      ? []
      : [
          `line ${block.start}: suppression row ${label} reads ${copied.get(label) ?? "nothing"}, which no longer matches HEAD (${current.get(label) ?? "no row"}). ${rerun}`,
        ],
  );
}

function revisionProblems(root: string, block: BodyBlock, rerun: string) {
  const stamp = block.stamp;
  if (stamp === undefined) return [];
  for (const sha of [stamp.base, stamp.head])
    if (!git(root, ["cat-file", "-e", `${sha}^{commit}`]).ok)
      return [
        `line ${block.start}: proof block names ${sha.slice(0, 12)}, a commit this checkout does not have. Fetch the full history (fetch-depth: 0), or ${rerun}`,
      ];
  if (!git(root, ["merge-base", "--is-ancestor", stamp.head, "HEAD"]).ok)
    return [
      `line ${block.start}: proof block stamped at ${stamp.head.slice(0, 12)}, which is not in this branch's history. ${rerun}`,
    ];
  const head = git(root, ["rev-parse", "HEAD"]).out;
  const trees = [stamp.head, head].map(
    (sha) => git(root, ["rev-parse", `${sha}^{tree}`]).out,
  );
  if (stamp.command.startsWith("antelopejs-api-diff") && trees[0] !== trees[1])
    return [
      `line ${block.start}: proof block stamped at ${stamp.head.slice(0, 12)}, but HEAD is ${head.slice(0, 12)}. ${rerun}`,
    ];
  return suppressionProblems(root, block, rerun);
}

function proofProblems(root: string, block: BodyBlock): string[] {
  const stamp = block.stamp;
  if (stamp === undefined) return [];
  const rerun = `Re-run \`${stamp.command}\` at HEAD and copy its whole output, its closing antelopejs-proof stamp included.`;
  const lines = block.lines.map(({ text }) => text);
  if (proofDigest(stamp, lines) !== stamp.digest)
    return [
      `line ${block.start}: proof block edited after \`${stamp.command}\` printed it. ${rerun}`,
    ];
  return revisionProblems(root, block, rerun);
}

/** Checks a pull request body against the repository at HEAD: stamped proof blocks are unedited and current, bin output appears only inside them, and findings blocks list live diagnostics. Returns one message per problem. */
export function checkBody(root: string, body: string): string[] {
  const { blocks, outside } = scanBody(body);
  let diagnostics: Diagnostic[] | undefined;
  const problems = outsideProblems(outside);
  for (const block of blocks) {
    if (block.kind === "proof") problems.push(...proofProblems(root, block));
    else {
      diagnostics ??= lintDiagnostics(root);
      problems.push(...findingsProblems(block, diagnostics));
    }
  }
  return problems;
}

/** The findings block for every lint finding in the working tree, ready to paste into a pull request body. */
export function findingsBlock(root: string): string {
  return formatFindings(lintDiagnostics(root));
}
