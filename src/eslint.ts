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
  /** Import order follows side-effectful setup and belongs to the formatter. */
  "import/first": "off",
  "import/order": "off",

  /** Single-word pages are intentional; withDefaults supplies prop defaults. */
  "vue/multi-word-component-names": "off",
  "vue/require-default-prop": "off",

  /** CMS blocks and forms require structural types in the interface layer. */
  "@typescript-eslint/no-explicit-any": "off",
  "@typescript-eslint/no-empty-object-type": "off",

  /** Separate event signatures preserve their documentation. */
  "@typescript-eslint/unified-signatures": "off",

  /** Underscores mark intentionally unused bindings. */
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
): ReturnType<typeof createConfigForNuxt> {
  const overrides = { ...ANTELOPE_NUXT_RULES, ...options.rules };
  return createConfigForNuxt({
    features: { tooling: true },
    dirs: { src: options.dirs ?? [] },
  }).onResolved((configs) =>
    configs.map((config) => {
      if (config.rules === undefined) return config;
      const rules = { ...config.rules };
      for (const [name, original] of Object.entries(rules)) {
        const rule = overrides[name] === undefined ? original : overrides[name];
        if (rule === null) delete rules[name];
        else if (rule === "warn" || rule === 1) rules[name] = "error";
        else if (Array.isArray(rule) && (rule[0] === "warn" || rule[0] === 1)) {
          rules[name] = ["error", ...rule.slice(1)];
        } else rules[name] = rule;
      }
      return { ...config, rules };
    }),
  );
}
