import { minimatch } from "minimatch";

/**
 * Whether `file` matches `glob`, dotfiles and dot folders included: `src/**`
 * matches `src/.env` and `**` matches `.prettierrc`, while braces, classes,
 * extglobs and negations keep their meaning (`{.env,.npmrc}` matches `.env`,
 * `[!.]*` does not). `path.matchesGlob` never lets a wildcard match a
 * leading dot, so a diff touching only a dotfile would map to no feature.
 */
export function matchesPath(file: string, glob: string): boolean {
  return minimatch(file, glob, { dot: true });
}
