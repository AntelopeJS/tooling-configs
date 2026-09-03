import { createConfigForNuxt } from "@nuxt/eslint-config/flat";

/** The rule map `overrideRules` accepts, derived so no transitive type is named. */
type NuxtRules = Parameters<
  ReturnType<typeof createConfigForNuxt>["overrideRules"]
>[0];

export interface AntelopeNuxtConfigOptions {
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
export const ANTELOPE_NUXT_RULES: NuxtRules = {
  // Nuxt layers import composables after side-effectful setup, and import order
  // is owned by the formatter's own sorting, not by a lint rule.
  "import/first": "off",
  "import/order": "off",

  // Layers ship single-word page components (`index`, `login`) by design, and
  // props default through `withDefaults` rather than per-prop declarations.
  "vue/multi-word-component-names": "off",
  "vue/require-default-prop": "off",

  // The CMS types blocks and forms structurally; `any` and `{}` are load-bearing
  // in the interface layer rather than accidents.
  "@typescript-eslint/no-explicit-any": "off",
  "@typescript-eslint/no-empty-object-type": "off",

  // Underscore-prefixed bindings are the convention for a deliberately unused
  // parameter, which the default rule reports.
  "@typescript-eslint/no-unused-vars": [
    "error",
    {
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
    },
  ],
};

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
export function antelopeNuxtConfig(
  options: AntelopeNuxtConfigOptions = {},
  // Annotated rather than inferred: the composer's type lives in a transitive
  // package, which pnpm's isolated layout cannot name from a declaration file.
): ReturnType<typeof createConfigForNuxt> {
  return createConfigForNuxt({
    features: { tooling: true },
    dirs: { src: options.dirs ?? [] },
  }).overrideRules({ ...ANTELOPE_NUXT_RULES, ...options.rules });
}
