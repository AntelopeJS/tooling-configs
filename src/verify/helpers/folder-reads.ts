import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

/** The entries of a folder, empty when it does not exist. */
export function entries(folder: string): string[] {
  return existsSync(folder) ? readdirSync(folder) : [];
}

/** A file's text. */
export function text(file: string): string {
  return readFileSync(file, "utf8");
}

/** Cuts a file down to its first `bytes` bytes, as an interrupted download leaves it. */
export function truncate(file: string, bytes: number): void {
  writeFileSync(file, readFileSync(file).subarray(0, bytes));
}
