import { parseProofStamp, proofLines, type ProofStamp } from "./proof-stamp.ts";

export const FINDINGS_BEGIN = "<!-- antelopejs-findings begin -->";
export const FINDINGS_END = "<!-- antelopejs-findings end -->";

const CODE_FILE_SOURCE =
  /(?<![\w@.[\]/-])(?:[\w@.[\]-]+\/)*[\w@[\]-][\w@.[\]-]*\.(?:[cm]?[jt]sx?|vue)(?!\w)/u
    .source;

/** A `path:line` reference to a code file, as a findings list writes it. */
export const CODE_REFERENCE = new RegExp(`${CODE_FILE_SOURCE}:\\d+`, "u");

/** A mention of a code file, with or without a line. A bare `.d.ts` names no file. */
export const CODE_MENTION = new RegExp(`${CODE_FILE_SOURCE}(?::\\d+)?`, "u");

export interface BodyLine {
  /** One-based line number in the body. */
  number: number;
  text: string;
  /** Whether the line sits under a heading that announces findings left under the ratchet. */
  inFindingsSection: boolean;
}

export interface BodyBlock {
  kind: "proof" | "findings";
  start: number;
  lines: BodyLine[];
  /** The stamp line closing a proof block; `undefined` for a findings block. */
  stamp: ProofStamp | undefined;
  closed: boolean;
}

export interface ScannedBody {
  blocks: BodyBlock[];
  outside: BodyLine[];
}

function isFindingsHeading(title: string): boolean {
  return (
    (/\b(?:left|remaining|kept)\b/iu.test(title) &&
      /\b(?:ratchet|findings?)\b/iu.test(title)) ||
    /^not fixed\b/iu.test(title)
  );
}

/** The title a plain or bold line stands for: the whole line, without emphasis or a closing colon. Prose sentences have none. */
function plainTitle(trimmed: string): string | undefined {
  const title = trimmed
    .replace(/^(\*\*|__)(.+?)\1:?$/u, "$2")
    .replace(/:$/u, "");
  return /^[A-Za-z][\w ,'()-]{0,79}$/u.test(title) ? title : undefined;
}

class SectionTracker {
  private fenced = false;
  private level: number | undefined;
  private plain = false;

  /** Follows headings outside code fences, and plain or bold title lines that name findings left, and reports whether `text` sits in a findings-left section. A heading section ends at the next heading of its level or above, a plain one at the next heading. */
  visit(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.startsWith("```")) this.fenced = !this.fenced;
    if (this.fenced) return this.level !== undefined || this.plain;
    const heading = /^(#{1,6})\s+(.*)$/u.exec(trimmed);
    if (heading) {
      this.plain = false;
      const level = heading[1].length;
      if (this.level !== undefined && level <= this.level)
        this.level = undefined;
      if (this.level === undefined && isFindingsHeading(heading[2]))
        this.level = level;
    } else {
      const title = plainTitle(trimmed);
      if (title !== undefined && isFindingsHeading(title)) this.plain = true;
    }
    return this.level !== undefined || this.plain;
  }
}

/** Moves the lines a stamp covers out of `outside`: its digested line count, counted back from the stamp, blank lines and fences included. */
function proofBlock(outside: BodyLine[], stamp: ProofStamp, at: number) {
  const lines: BodyLine[] = [];
  let counted = 0;
  while (counted < stamp.lines && outside.length > 0) {
    const line = outside.pop();
    if (line === undefined) break;
    lines.unshift(line);
    counted += proofLines([line.text]).length;
  }
  const block: BodyBlock = {
    kind: "proof",
    start: lines.at(0)?.number ?? at,
    lines,
    stamp,
    closed: true,
  };
  return block;
}

/** Splits a pull request body into stamped proof blocks, findings blocks, and the lines outside both. */
export function scanBody(body: string): ScannedBody {
  const scanned: ScannedBody = { blocks: [], outside: [] };
  const sections = new SectionTracker();
  let findings: BodyBlock | undefined;
  body.split(/\r?\n/u).forEach((text, index) => {
    const line = {
      number: index + 1,
      text,
      inFindingsSection: sections.visit(text),
    };
    const trimmed = text.trim();
    const stamp = parseProofStamp(text);
    if (findings !== undefined) {
      if (trimmed === FINDINGS_END) {
        findings.closed = true;
        findings = undefined;
      } else findings.lines.push(line);
    } else if (trimmed === FINDINGS_BEGIN) {
      findings = {
        kind: "findings",
        start: line.number,
        lines: [],
        stamp: undefined,
        closed: false,
      };
      scanned.blocks.push(findings);
    } else if (stamp !== undefined)
      scanned.blocks.push(proofBlock(scanned.outside, stamp, line.number));
    else scanned.outside.push(line);
  });
  return scanned;
}
