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
  /** Binaries Knip cannot resolve, appended to the AntelopeJS defaults. */
  ignoreBinaries?: string[];
}

const DEFAULT_ENTRY = [
  // `src/index.ts` is not listed: Knip already reads it from package.json, and
  // repeating it there is reported as a redundant pattern.
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

/**
 * `typecheck` is a script in the Nuxt layer's own manifest, outside the analysed
 * project, and every layer's CI runs it.
 *
 * The AntelopeJS CLIs are deliberately absent: a repository that invokes `ajs`
 * or `acms` declares the package providing it, so Knip resolves them and an
 * ignore would only hide a missing dependency.
 */
const DEFAULT_IGNORE_BINARIES = ["typecheck"];

/**
 * The AntelopeJS runtime loads modules by name, from the antelope config rather
 * than through an import, so nothing in the source points at them and Knip reads
 * every one as dead weight.
 */
const DEFAULT_IGNORE_DEPENDENCIES = ["@antelopejs/.*"];

export function antelopeKnipConfig(
  options: AntelopeKnipOptions = {},
): KnipConfig {
  return {
    entry: [...DEFAULT_ENTRY, ...(options.entry ?? [])],
    project: [...DEFAULT_PROJECT, ...(options.project ?? [])],
    ignore: [...DEFAULT_IGNORE, ...(options.ignore ?? [])],
    ignoreDependencies: [
      ...DEFAULT_IGNORE_DEPENDENCIES,
      ...(options.ignoreDependencies ?? []),
    ],
    ignoreBinaries: [
      ...DEFAULT_IGNORE_BINARIES,
      ...(options.ignoreBinaries ?? []),
    ],
  };
}
