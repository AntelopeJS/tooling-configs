import { relative, sep } from "node:path";

/** `path` relative to `root` with `/` separators on every platform, as messages name a file. */
export function repoPath(root, path) {
  return relative(root, path).split(sep).join("/");
}

/** `path` with `/` separators, as the TypeScript compiler names files on every platform. */
export function slashPath(path) {
  return path.split(sep).join("/");
}
