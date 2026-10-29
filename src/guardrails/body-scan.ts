import { parseProofStamp, proofLines, type ProofStamp } from "./proof-stamp.ts";

export const FINDINGS_BEGIN = "<!-- antelopejs-findings begin -->";
export const FINDINGS_END = "<!-- antelopejs-findings end -->";

/** A `path:line` reference to a code file, as a findings list writes it. */
export const CODE_REFERENCE =
  /(?:[\w@.[\]-]+\/)*[\w@.[\]-]+\.(?:[cm]?[jt]sx?|vue):\d+/u;

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
    /\b(?:left|remaining)\b/iu.test(title) &&
    /\b(?:ratchet|findings?)\b/iu.test(title)
  );
}

class SectionTracker {
  private fenced = false;
  private level: number | undefined;

  /** Follows headings outside code fences and reports whether `text` sits in a findings-left section. */
  visit(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.startsWith("```")) this.fenced = !this.fenced;
    const heading = this.fenced ? null : /^(#{1,6})\s+(.*)$/u.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      if (this.level !== undefined && level <= this.level)
        this.level = undefined;
      if (this.level === undefined && isFindingsHeading(heading[2]))
        this.level = level;
    }
    return this.level !== undefined;
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
