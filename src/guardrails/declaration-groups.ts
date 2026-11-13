import {
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
