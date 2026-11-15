import { createRequire } from "node:module";
import type ts from "typescript";

import { requireTypeScript6 } from "../typescript-version.ts";

let compiler: typeof ts | undefined;

/** This package's own TypeScript 6, loaded on first use, so the count never depends on the compiler a repository installs (TypeScript 7 has no parser API). */
export function typescript(): typeof ts {
  if (compiler) return compiler;
  /* SAFETY: the pack depends on `typescript` 6, whose module object is the compiler API it declares; requireTypeScript6 rejects another version an override forces before it is used. */
  const loaded = createRequire(import.meta.url)("typescript") as typeof ts;
  requireTypeScript6(loaded.version);
  compiler = loaded;
  return compiler;
}
