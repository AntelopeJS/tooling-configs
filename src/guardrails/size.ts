import { MAX_FILE_BYTES } from "./ceilings.ts";
import { authoredSizes } from "./files.ts";

function sizeFailure(file: string, size: number): string {
  return `${file}: ${size} bytes, ${size - MAX_FILE_BYTES} bytes over the ${MAX_FILE_BYTES}-byte ceiling. Split by responsibility into sibling modules, one cohesive group of exports each; keep the original path re-exporting only if it is a public entry point. Split a test file by behaviour under test, one file per describe. Do not minify, strip whitespace, or move code under an excluded path to pass.`;
}

export function checkSize(
  root: string,
  files?: string[],
  staged = false,
): string[] {
  const failures: string[] = [];
  for (const [file, size] of authoredSizes(root, files, staged)) {
    if (size > MAX_FILE_BYTES) failures.push(sizeFailure(file, size));
  }
  return failures;
}
