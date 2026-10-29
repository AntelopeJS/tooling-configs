import type { PackageManager } from "./package.ts";

export const DOCS_COMPAT_START = "<!-- antelopejs-docs-compat:start -->";
export const DOCS_COMPAT_END = "<!-- antelopejs-docs-compat:end -->";

/** One `@antelopejs/*` dependency of a package: its declared range and the version the lockfile resolves. */
export interface CompatRow {
  name: string;
  supported: string;
  tested: string | undefined;
}

/** The generated block, rows sorted by package name, formatted as oxfmt leaves it. */
export function compatBlock(_rows: readonly CompatRow[]): string {
  return "";
}

/** The README with the block in place: replacing the markers, a legacy `docs-compat` table, or under `## Compatibility`. */
export function placeCompatBlock(
  current: string | undefined,
  _block: string,
): string {
  return current ?? "";
}

/** What sync writes for the documentation: each qualifying package's README and the caller's `docs-files` lines. */
export interface DocsPlan {
  readmes: { path: string; current: string | undefined; content: string }[];
  docsFiles: string[];
  errors: string[];
}

export function planDocs(_root: string, _manager: PackageManager): DocsPlan {
  return { readmes: [], docsFiles: [], errors: [] };
}
