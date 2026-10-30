import { CODE_REFERENCE, FINDINGS_BEGIN, FINDINGS_END } from "./body-scan.ts";
import type { BodyBlock, BodyLine } from "./body-scan.ts";
import type { Diagnostic } from "./oxlint.ts";

const PLACEHOLDER = "<why>";
const ITEM = /^[-*+]\s+`([^`\s]+?):(\d+)(?::\d+)?`\s+`([^`\s]+)`\s*:?\s*(.*)$/u;
const CLAIM_BEFORE = /(\d+)\s*(?:×\s*)?`([^`\s]+)`/gu;
const CLAIM_AFTER = /`([^`\s]+)`\s*\((\d+)\)/gu;
const RECOPY = "Copy the list again from `antelopejs-body-check --findings`.";

interface Item {
  line: number;
  file: string;
  at: number;
  rule: string;
  why: string;
}

interface Claim {
  line: number;
  name: string;
  count: number;
}

const key = (file: string, line: number, rule: string) =>
  `${file}:${line} \`${rule}\``;

function tally(keys: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of keys) counts.set(entry, (counts.get(entry) ?? 0) + 1);
  return counts;
}

function readItem(line: BodyLine): Item | undefined {
  const match = ITEM.exec(line.text.trim());
  if (!match) return undefined;
  const [, file, at, rule, why] = match;
  return { line: line.number, file, at: Number(at), rule, why: why.trim() };
}

function readClaims(line: BodyLine): Claim[] {
  const claims = [...line.text.matchAll(CLAIM_BEFORE)].map((match) => ({
    line: line.number,
    name: match[2],
    count: Number(match[1]),
  }));
  for (const match of line.text.matchAll(CLAIM_AFTER))
    claims.push({ line: line.number, name: match[1], count: Number(match[2]) });
  return claims;
}

const names = (rule: string, name: string) =>
  rule === name || rule.endsWith(`/${name}`);

function claimProblems(items: Item[], claims: Claim[], rules: Set<string>) {
  const known = claims.flatMap((claim) => {
    const rule = [...rules].find((candidate) => names(candidate, claim.name));
    return rule === undefined ? [] : [{ ...claim, rule }];
  });
  return known.flatMap((claim) => {
    const next = known.find(
      (other) => other.line > claim.line && other.rule === claim.rule,
    );
    const listed = items.filter(
      (item) =>
        item.line > claim.line &&
        (next === undefined || item.line < next.line) &&
        item.rule === claim.rule,
    ).length;
    return listed === claim.count
      ? []
      : [
          `line ${claim.line}: claims ${claim.count} \`${claim.name}\` but ${listed} listed under it. Drop the typed count or make the list match it.`,
        ];
  });
}

function liveProblems(items: Item[], diagnostics: Diagnostic[]): string[] {
  const live = tally(
    diagnostics.flatMap(({ file, line, rule }) =>
      line === undefined ? [] : [key(file, line, rule)],
    ),
  );
  const seen = new Map<string, number>();
  const problems: string[] = [];
  for (const item of items) {
    const entry = key(item.file, item.at, item.rule);
    seen.set(entry, (seen.get(entry) ?? 0) + 1);
    if ((seen.get(entry) ?? 0) <= (live.get(entry) ?? 0)) continue;
    const lines = diagnostics
      .filter(({ file, rule }) => file === item.file && rule === item.rule)
      .map(({ line }) => line)
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    const hint = lines.length ? ` (live at ${lines.join(", ")})` : "";
    problems.push(
      `line ${item.line}: ${item.file}:${item.at} has no live \`${item.rule}\` diagnostic at HEAD${hint}. ${RECOPY}`,
    );
  }
  const covered = new Set(items.map(({ rule }) => rule));
  for (const [entry, count] of live) {
    const rule = /`([^`]+)`$/u.exec(entry)?.[1] ?? "";
    if (covered.has(rule) && count > (seen.get(entry) ?? 0))
      problems.push(
        `${entry} is live at HEAD but not listed. List every finding of a rule the block lists. ${RECOPY}`,
      );
  }
  return problems;
}

/** Checks one findings block: every item is a live diagnostic at HEAD with a reason, every finding of a listed rule is listed, and every typed count matches the items under it. */
export function findingsProblems(
  block: BodyBlock,
  diagnostics: Diagnostic[],
): string[] {
  const problems: string[] = [];
  if (!block.closed)
    problems.push(
      `line ${block.start}: ${FINDINGS_BEGIN} has no ${FINDINGS_END}. ${RECOPY}`,
    );
  const items: Item[] = [];
  const claims: Claim[] = [];
  for (const line of block.lines) {
    const item = readItem(line);
    if (item !== undefined) items.push(item);
    else if (CODE_REFERENCE.test(line.text))
      problems.push(
        `line ${line.number}: write each finding as \`- \\\`path:line\\\` \\\`rule\\\`: why\`. ${RECOPY}`,
      );
    else claims.push(...readClaims(line));
  }
  for (const item of items)
    if (item.why === "" || item.why === PLACEHOLDER)
      problems.push(
        `line ${item.line}: ${item.file}:${item.at} \`${item.rule}\` has no reason; give the reason it stays under the ratchet.`,
      );
  const rules = new Set([
    ...items.map(({ rule }) => rule),
    ...diagnostics.map(({ rule }) => rule),
  ]);
  return [
    ...problems,
    ...liveProblems(items, diagnostics),
    ...claimProblems(items, claims, rules),
  ];
}

/** Prints every lint finding at HEAD as a findings block grouped by rule, with a `<why>` for the author to replace. */
export function formatFindings(diagnostics: Diagnostic[]): string {
  const groups = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics)
    if (diagnostic.line !== undefined)
      groups.set(diagnostic.rule, [
        ...(groups.get(diagnostic.rule) ?? []),
        diagnostic,
      ]);
  const sections = [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([rule, found]) =>
      [
        `\`${rule}\` (${found.length}):`,
        "",
        ...found
          .sort(
            (a, b) =>
              a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0),
          )
          .map(
            ({ file, line }) =>
              `- \`${file}:${line}\` \`${rule}\`: ${PLACEHOLDER}`,
          ),
      ].join("\n"),
    );
  return `${[FINDINGS_BEGIN, ...sections, FINDINGS_END].join("\n\n")}\n`;
}
