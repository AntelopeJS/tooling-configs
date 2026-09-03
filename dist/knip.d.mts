import { KnipConfig } from "knip";
//#region src/knip.d.ts
/**
 * Knip finds files, exports and dependencies nothing reaches any more. Its
 * defaults assume a conventional entry point, which an AntelopeJS module does
 * not have: the runtime loads `src/index.ts` and every interface subpath, and
 * `ajs module test` runs the compiled test tree rather than a test runner Knip
 * knows about. Without those declared, Knip reports the whole test suite as
 * dead code.
 */
interface AntelopeKnipOptions {
  /** Extra entry points, appended to the AntelopeJS defaults. */
  entry?: string[];
  /** Extra project files to analyse, appended to the AntelopeJS defaults. */
  project?: string[];
  /** Dependencies Knip cannot see (loaded by the runtime, a CLI, or a config). */
  ignoreDependencies?: string[];
  /** Paths to leave out entirely. */
  ignore?: string[];
}
declare function antelopeKnipConfig(options?: AntelopeKnipOptions): KnipConfig;
//#endregion
export { AntelopeKnipOptions, antelopeKnipConfig };