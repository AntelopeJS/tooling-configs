import { createConfigForNuxt } from "@nuxt/eslint-config/flat";

import { TYPE_AWARE_RULES, typeAwareRuleSetting } from "./type-aware-rules.ts";

/** The rule map `overrideRules` accepts, derived so no transitive type is named. */
type NuxtRules = Parameters<
  ReturnType<typeof createConfigForNuxt>["overrideRules"]
>[0];

export interface AntelopeNuxtConfigOptions {
  /** Extra source directories for the Nuxt config, e.g. `["./playground"]`. */
  dirs?: string[];
  /** Rules layered on top of the shared set. */
  rules?: NuxtRules;
  /**
   * Runs the type-aware rules of the oxlint preset on `.vue` script blocks,
   * which oxlint-tsgolint cannot read; TypeScript files stay with oxlint.
   * `tsconfigRootDir` is the project root, usually `import.meta.dirname`.
   * Each `.vue` file must be listed by its nearest `tsconfig.json`, or it
   * fails to parse. Without Volar, a type imported from another `.vue` file
   * is an error type, which the `no-unsafe-*` rules report, and a
   * `lang="tsx"` block fails to parse.
   */
  typeAware?: { tsconfigRootDir: string };
}

/**
 * The shared rules for a Nuxt layer. oxlint runs no Vue template rule and no
 * type-aware rule on `.vue` files, so the front end stays on ESLint, and
 * `@nuxt/eslint` supplies the Vue and TypeScript rules; this only records
 * where AntelopeJS layers differ from it.
 *
 * Formatting rules are deliberately absent. oxfmt formats `.vue`, and a lint
 * rule that also reflows markup (`vue/max-attributes-per-line`, which eight
 * layers carry today) would fight it on every save.
 */
export const ANTELOPE_NUXT_RULES: NuxtRules = {
  /** Import order follows side-effectful setup and belongs to the formatter. */
  "import/first": "off",
  "import/order": "off",

  /**
   * Single-word pages are intentional. The Vue 3 style guide asks no default
   * of a type-based optional prop, whose absence can carry meaning.
   */
  "vue/multi-word-component-names": "off",
  "vue/require-default-prop": "off",

  /**
   * TypeScript reports unreachable code only under
   * `allowUnreachableCode: false`, which no layer sets.
   */
  "no-unreachable": "error",

  /** A best-effort cleanup swallows its failure in an empty `catch`. */
  "no-empty": ["error", { allowEmptyCatch: true }],

  /**
   * The formatter writes a void element as `<input />` and a hex literal in
   * lower case, so these rules agree with it or stay off.
   */
  "vue/html-self-closing": ["error", { html: { void: "always" } }],
  "unicorn/number-literal-case": "off",

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
 * The script files that also get the `nuxt/vue/rules` rules, so a composable
 * keeps `vue/no-ref-as-operand` and the other script checks.
 */
const SCRIPT_FILES = ["**/*.?([cm])[jt]s?(x)"];

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
  const composer = createConfigForNuxt({
    features:
      options.typeAware === undefined
        ? { tooling: true }
        : { tooling: true, typescript: true },
    dirs: { src: options.dirs ?? [] },
  });
  if (options.typeAware !== undefined) {
    composer.append({
      name: "antelopejs/vue-type-aware",
      files: ["**/*.vue"],
      languageOptions: {
        parserOptions: {
          projectService: true,
          tsconfigRootDir: options.typeAware.tsconfigRootDir,
        },
      },
      rules: Object.fromEntries(
        TYPE_AWARE_RULES.map((rule) => [
          `@typescript-eslint/${rule}`,
          typeAwareRuleSetting(rule),
        ]),
      ),
    });
  }
  return composer.onResolved((configs) =>
    configs.flatMap((config) => {
      if (config.rules === undefined) return [config];
      const rules = { ...config.rules };
      for (const [name, original] of Object.entries(rules)) {
        const rule = overrides[name] === undefined ? original : overrides[name];
        if (rule === null) delete rules[name];
        else if (rule === "warn" || rule === 1) rules[name] = "error";
        else if (Array.isArray(rule) && (rule[0] === "warn" || rule[0] === 1)) {
          rules[name] = ["error", ...rule.slice(1)];
        } else rules[name] = rule;
      }
      const resolved = { ...config, rules };
      if (config.name !== "nuxt/vue/rules") return [resolved];
      return [
        resolved,
        {
          name: "antelopejs/vue-script",
          files: SCRIPT_FILES,
          rules: Object.fromEntries(
            Object.entries(rules).filter(([name]) => name.startsWith("vue/")),
          ),
        },
      ];
    }),
  );
}
