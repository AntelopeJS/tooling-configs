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

const HUNK = /^(@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@.*)$/u;

function collatedLines(output: string): string[] {
  const file = join(output, "declarations.d.ts");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
}

/** Appends to each hunk header of `diff`, a comparison of the collated `base` and `head` directories under `root`, the `// In` line of the declaration the hunk starts in, so a change far below that line still names its entries. */
export function labelHunks(diff: string, root: string): string {
  const base = collatedLines(join(root, "base"));
  const head = collatedLines(join(root, "head"));
  return diff
    .split("\n")
    .map((line) => {
      const match = HUNK.exec(line);
      if (!match) return line;
      const [, hunk, baseStart, headStart, headCount] = match;
      const [lines, start] =
        headCount === "0" || !head.length
          ? [base, Number(baseStart)]
          : [head, Number(headStart)];
      const carriers = lines
        .slice(0, start)
        .findLast((text) => text.startsWith("// In "));
      return carriers === undefined ? line : `${hunk} ${carriers}`;
    })
    .join("\n");
}

/** Replaces the bundled entries under `output` with one `declarations.d.ts`: an index of the entries, then each declaration text once, under the entries that carry it, so a change shared by many entries is printed once. Statements of one name are kept together in written order, so a reordered overload still differs. */
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
            `// In ${carriers.length === entries.length ? "every entry" : carriers.join(", ")}\n${text}\n`,
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
