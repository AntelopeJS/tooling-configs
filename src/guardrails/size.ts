import { MAX_FILE_BYTES, readCeilings } from "./ceilings.ts";
import { authoredSizes } from "./files.ts";

export function sizeFailure(file: string, size: number, limit: number): string {
  return `${file}: ${size} bytes, ${size - limit} bytes over the ${limit}-byte ceiling. Split by responsibility into sibling modules, one cohesive group of exports each; keep the original path re-exporting only if it is a public entry point. Split a test file by behaviour under test, one file per describe. Do not minify, strip whitespace, or move code under an excluded path to pass.`;
}

export function checkSize(
  root: string,
  files?: string[],
  staged = false,
): string[] {
  const ceilings = readCeilings(root);
  const failures: string[] = [];
  for (const [file, size] of authoredSizes(root, files, staged)) {
    const limit = ceilings.oversizeFiles[file] ?? MAX_FILE_BYTES;
    if (size > limit) failures.push(sizeFailure(file, size, limit));
  }
  return failures;
}
