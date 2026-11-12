import { createRequire } from "node:module";
import type ts from "@typescript/typescript6";

let compiler: typeof ts | undefined;

/** This package's own TypeScript 6, loaded on first use, so the count never depends on the compiler a repository installs (TypeScript 7 has no parser API). */
export function typescript(): typeof ts {
  /* SAFETY: `@typescript/typescript6` re-exports TypeScript 6, whose module object is the compiler API it declares. */
  compiler ??= createRequire(import.meta.url)(
    "@typescript/typescript6",
  ) as typeof ts;
  return compiler;
}
