import { matchesGlob } from "node:path";

const HIDDEN = "\u0000";

function unhide(path: string): string {
  return path
    .split("/")
    .map((segment) =>
      segment.startsWith(".") ? `${HIDDEN}${segment.slice(1)}` : segment,
    )
    .join("/");
}

/**
 * Whether `file` matches `glob`, dotfiles and dot folders included: `src/**`
 * matches `src/.env`, and `**` matches `.prettierrc`. `path.matchesGlob` alone
 * never lets a wildcard match a leading dot, so a diff touching only a
 * dotfile would map to no feature. A dot written in the glob still matches
 * only that dot.
 */
export function matchesPath(file: string, glob: string): boolean {
  return matchesGlob(unhide(file), unhide(glob));
}
