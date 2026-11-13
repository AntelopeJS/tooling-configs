import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A temporary directory holding the given files, read back by name. */
export function scratchFiles(files: Readonly<Record<string, string>>) {
  const root = mkdtempSync(join(tmpdir(), "antelope-scratch-"));
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(root, name), source);
  }
  return {
    root,
    read: (name: string) => readFileSync(join(root, name), "utf8"),
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}
