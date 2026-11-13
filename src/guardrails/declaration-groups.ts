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

/** Appends to a hunk header of `diff`, a comparison of the collated `base` and `head` directories under `root`, the entries of the declaration its first changed declaration line belongs to, when the `// In` lines of that declaration lie above the hunk. A change far below those lines still names its entries, and a hunk that changes only `// In` or index lines is left as git printed it. */
export function labelHunks(diff: string, root: string): string {
  const sides: Record<Mark, string[]> = {
    "-": collatedLines(join(root, "base")),
    "+": collatedLines(join(root, "head")),
  };
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
      if (line.startsWith("//", 1)) continue;
      const run = carrierRun(sides[mark], at);
      if (run !== undefined && run.start < hunk.start[mark])
        lines[hunk.header] += ` ${run.label}`;
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
      `// Entries\n${entries.map((entry) => `//   ${entry}\n`).join("")}`,
      ...blocks,
    ].join("\n"),
  );
}
