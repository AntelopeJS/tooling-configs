import { createRequire } from "node:module";
import type ts from "typescript";

let compiler: typeof ts | undefined;

/** This package's own TypeScript 5, loaded on first use, so the count never depends on the compiler a repository installs (TypeScript 7 has no parser API). */
export function typescript(): typeof ts {
  /* SAFETY: the `typescript` dependency is pinned to 5.x, which exports the parser API. */
  compiler ??= createRequire(import.meta.url)("typescript") as typeof ts;
  return compiler;
}
