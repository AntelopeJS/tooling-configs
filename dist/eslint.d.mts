import { createConfigForNuxt } from "@nuxt/eslint-config/flat";
//#region src/eslint.d.ts
/** The rule map `overrideRules` accepts, derived so no transitive type is named. */
type NuxtRules = Parameters<ReturnType<typeof createConfigForNuxt>["overrideRules"]>[0];
interface AntelopeNuxtConfigOptions {
  /** Extra source directories for the Nuxt config, e.g. `["./playground"]`. */
  dirs?: string[];
  /** Rules layered on top of the shared set. */
  rules?: NuxtRules;
}
/**
 * The shared rules for a Nuxt layer. oxlint does not lint `.vue` files yet, so
 * the front end stays on ESLint, and `@nuxt/eslint` supplies the Vue and
 * TypeScript rules; this only records where AntelopeJS layers differ from it.
 *
 * Formatting rules are deliberately absent. oxfmt formats `.vue`, and a lint
 * rule that also reflows markup (`vue/max-attributes-per-line`, which eight
 * layers carry today) would fight it on every save.
 */
declare const ANTELOPE_NUXT_RULES: NuxtRules;
/**
 * ESLint config for an AntelopeJS Nuxt layer.
 *
 * @example
 * ```js
 * // eslint.config.mjs
 * import { antelopeNuxtConfig } from "@antelopejs/tooling-configs/eslint";
 *
 * export default antelopeNuxtConfig({ dirs: ["./playground"] });
 * ```
 */
declare function antelopeNuxtConfig(options?: AntelopeNuxtConfigOptions): ReturnType<typeof createConfigForNuxt>;
//#endregion
export { ANTELOPE_NUXT_RULES, AntelopeNuxtConfigOptions, antelopeNuxtConfig };