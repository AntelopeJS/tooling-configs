import { relative, sep } from "node:path";

/** `path` with `/` between its segments on every platform, as git and the messages this pack prints spell it. */
function slashed(path: string): string {
  return path.split(sep).join("/");
}

/** The path from `from` to `to`, spelled with `/` on every platform. */
export function relativeSlashed(from: string, to: string): string {
  return slashed(relative(from, to));
}
