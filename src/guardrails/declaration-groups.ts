import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

import type ts from "@typescript/typescript6";

import { namedStatements } from "./declaration-order.ts";

/** For each declaration name, each distinct text of that name and the entries that carry it. */
type Declarations = Map<string, Map<string, string[]>>;

function entryFiles(output: string): string[] {
  return readdirSync(output, { recursive: true, withFileTypes: true })
    .filter((file) => file.isFile())
    .map((file) =>
      relative(output, join(file.parentPath, file.name)).split("\\").join("/"),
    )
    .sort();
}

function byText([a]: [string, string[]], [b]: [string, string[]]): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function collectDeclarations(
  compiler: typeof ts,
  output: string,
  entries: readonly string[],
): Declarations {
  const declarations: Declarations = new Map();
  for (const entry of entries) {
    const texts = new Map<string, string[]>();
    for (const { name, text } of namedStatements(
      compiler,
      readFileSync(join(output, entry), "utf8"),
    ))
      texts.set(name, [...(texts.get(name) ?? []), text]);
    for (const [name, parts] of texts) {
      const variants = declarations.get(name) ?? new Map<string, string[]>();
      const text = parts.join("\n");
      variants.set(text, [...(variants.get(text) ?? []), entry]);
      declarations.set(name, variants);
    }
  }
  return declarations;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;
const CARRIER = "// In ";
const INDEX = "// Entries";
const INDEXED = "//   ";

/** Whether `text`, a line of a collated file, is a separator, an index line or a `// In` line rather than declaration text. */
function isLayout(text: string): boolean {
  return (
    text === "" ||
    text === INDEX ||
    text.startsWith(INDEXED) ||
    text.startsWith(CARRIER)
  );
}

type Mark = "-" | "+";

interface Hunk {
  header: number;
  start: Record<Mark, number>;
  next: Record<Mark, number>;
}

function collatedLines(output: string): string[] {
  const file = join(output, "declarations.d.ts");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
}

/** The run of `// In` lines heading the declaration that holds `line`, a 1-based line number: its first line number and its entries joined into one `// In` line. */
function carrierRun(
  lines: readonly string[],
  line: number,
): { start: number; label: string } | undefined {
  let end = line - 1;
  while (end >= 0 && !lines[end].startsWith(CARRIER)) end -= 1;
  if (end < 0) return undefined;
  let start = end;
  while (lines[start - 1]?.startsWith(CARRIER)) start -= 1;
  return {
    start: start + 1,
    label: `${CARRIER}${lines
      .slice(start, end + 1)
      .map((text) => text.slice(CARRIER.length))
      .join(", ")}`,
  };
}

/** Appends `run`'s entries to the header of `hunk` when the run lies above it and no earlier hunk showed or named it, and records the run as named. */
function labelHunk(
  lines: string[],
  hunk: Hunk,
  mark: Mark,
  run: ReturnType<typeof carrierRun>,
  labelled: Set<string>,
): void {
  if (run === undefined) return;
  const key = `${mark}${run.start}`;
  if (run.start < hunk.start[mark] && !labelled.has(key))
    lines[hunk.header] += ` ${run.label}`;
  labelled.add(key);
}

/** Appends to a hunk header of `diff`, a comparison of the collated `base` and `head` directories under `root`, the entries of the declaration its first changed declaration line belongs to, when the `// In` lines of that declaration lie above the hunk and no earlier hunk named them. A change far below those lines still names its entries, a hunk that changes only separators, `// In` or index lines is left as git printed it, and a declaration changed in many hunks names its entries once. */
export function labelHunks(diff: string, root: string): string {
  const sides: Record<Mark, string[]> = {
    "-": collatedLines(join(root, "base")),
    "+": collatedLines(join(root, "head")),
  };
  const labelled = new Set<string>();
  const lines = diff.split("\n");
  let hunk: Hunk | undefined;
  for (const [index, line] of lines.entries()) {
    const match = HUNK.exec(line);
    if (match) {
      const start = { "-": Number(match[1]), "+": Number(match[2]) };
      hunk = { header: index, start, next: { ...start } };
      continue;
    }
    if (hunk === undefined) continue;
    if (line.startsWith("diff --git ")) hunk = undefined;
    else if (line.startsWith(" ")) {
      hunk.next["-"] += 1;
      hunk.next["+"] += 1;
    } else if (line.startsWith("-") || line.startsWith("+")) {
      const mark: Mark = line.startsWith("-") ? "-" : "+";
      const at = hunk.next[mark];
      hunk.next[mark] += 1;
      if (isLayout(line.slice(1))) continue;
      labelHunk(lines, hunk, mark, carrierRun(sides[mark], at), labelled);
      hunk = undefined;
    }
  }
  return lines.join("\n");
}

/** Replaces the bundled entries under `output` with one `declarations.d.ts`: an index of the entries, then each declaration text once, under one `// In` line per entry that carries it, or `// In every entry`. A change shared by many entries is printed once, and an added or removed entry adds or removes one line per declaration it shares. Statements of one name are kept together in written order, so a reordered overload still differs. */
export function collateDeclarations(compiler: typeof ts, output: string): void {
  const entries = entryFiles(output);
  if (!entries.length) return;
  const declarations = collectDeclarations(compiler, output, entries);
  const blocks = [...declarations]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, variants]) =>
      [...variants]
        .sort(byText)
        .map(
          ([text, carriers]) =>
            `${(carriers.length === entries.length ? ["every entry"] : carriers).map((carrier) => `${CARRIER}${carrier}\n`).join("")}${text}\n`,
        ),
    );
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, "declarations.d.ts"),
    [
      `${INDEX}\n${entries.map((entry) => `${INDEXED}${entry}\n`).join("")}`,
      ...blocks,
    ].join("\n"),
  );
}
