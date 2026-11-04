import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Every file under `root`, by path relative to it, with its text. */
export function readTree(root: string, directory = ""): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(join(root, directory), {
    withFileTypes: true,
  })) {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      for (const [name, text] of readTree(root, path)) files.set(name, text);
    else files.set(path, readFileSync(join(root, path), "utf8"));
  }
  return files;
}

/** The text of a file, for a test that compares generated output with a committed copy. */
export function readText(path: string): string {
  return readFileSync(path, "utf8");
}
