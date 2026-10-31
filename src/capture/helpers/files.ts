import { readFileSync, statSync } from "node:fs";

/** The bytes of a capture the test just wrote or left alone. */
export function bytesOf(path: string): Buffer {
  return readFileSync(path);
}

/** When the file was last written, in milliseconds. */
export function modifiedAt(path: string): number {
  return statSync(path).mtimeMs;
}
