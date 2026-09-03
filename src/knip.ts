import type { KnipConfig } from "knip";

/**
 * Knip finds files, exports and dependencies nothing reaches any more. Its
 * defaults assume a conventional entry point, which an AntelopeJS module does
 * not have: the runtime loads `src/index.ts` and every interface subpath, and
 * `ajs module test` runs the compiled test tree rather than a test runner Knip
 * knows about. Without those declared, Knip reports the whole test suite as
 * dead code.
 */
export interface AntelopeKnipOptions {
  /** Extra entry points, appended to the AntelopeJS defaults. */
  entry?: string[];
  /** Extra project files to analyse, appended to the AntelopeJS defaults. */
  project?: string[];
  /** Dependencies Knip cannot see (loaded by the runtime, a CLI, or a config). */
  ignoreDependencies?: string[];
  /** Paths to leave out entirely. */
  ignore?: string[];
}

const DEFAULT_ENTRY = [
  "src/index.ts",
  // Public API: consumers import these through the package's `exports` subpaths.
  "src/interfaces/**/*.ts",
  // Run by `ajs module test`, which Knip has no plugin for.
  "src/test/**/*.test.ts",
  "scripts/**/*.{ts,mjs}",
];

const DEFAULT_PROJECT = ["src/**/*.ts", "scripts/**/*.{ts,mjs}"];

const DEFAULT_IGNORE = [
  "dist/**",
  "nuxt-layer/**",
  "playground/**",
  ".antelope/**",
];

export function antelopeKnipConfig(options: AntelopeKnipOptions = {}): KnipConfig {
  return {
    entry: [...DEFAULT_ENTRY, ...(options.entry ?? [])],
    project: [...DEFAULT_PROJECT, ...(options.project ?? [])],
    ignore: [...DEFAULT_IGNORE, ...(options.ignore ?? [])],
    ignoreDependencies: options.ignoreDependencies ?? [],
  };
}
