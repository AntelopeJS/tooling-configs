import { defineConfig } from "oxfmt";

import { AGENT_IGNORE_PATTERNS, IGNORE_PATTERNS } from "./shared.ts";

type OxfmtOptions = Parameters<typeof defineConfig>[0];

/**
 * The house style. Every field is set explicitly, including the ones that match
 * oxfmt's own defaults: repositories carry `.editorconfig` files that disagree
 * with each other (five declare tabs, two declare spaces), and oxfmt falls back
 * to `.editorconfig` for any field a config leaves unset. Stating all of them
 * is what makes the style the same everywhere.
 */
export const ANTELOPE_STYLE = {
  printWidth: 80,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  trailingComma: "all",
} as const;

export interface AntelopeFmtOptions extends Partial<OxfmtOptions> {
  /**
   * Sort Tailwind classes, replacing `prettier-plugin-tailwindcss`. Pass the
   * path to the stylesheet that declares the theme, as the Nuxt layers do.
   */
  tailwindStylesheet?: string;
  /**
   * Extra paths to leave alone. These are **added** to the shared ignores, not
   * substituted for them: a repository adopting oxfmt in stages needs to park
   * `nuxt-layer/**` for a while without also un-ignoring its own build output.
   */
  ignorePatterns?: string[];
}

/**
 * The shared AntelopeJS oxfmt preset.
 *
 * Import order is deliberately absent: `perfectionist/sort-imports` owns it on
 * the lint side, and two tools sorting the same imports differently would each
 * undo the other's work on every save.
 *
 * @example
 * ```ts
 * // oxfmt.config.ts
 * import { antelopeFmtPreset } from "@antelopejs/tooling-configs/oxc/fmt";
 *
 * export default antelopeFmtPreset();
 * ```
 */
export function antelopeFmtPreset(options: AntelopeFmtOptions = {}) {
  const { tailwindStylesheet, ignorePatterns = [], ...overrides } = options;
  const tailwind =
    tailwindStylesheet === undefined
      ? {}
      : {
          sortTailwindcss: {
            stylesheet: tailwindStylesheet,
            functions: ["clsx", "cn"],
          },
        };

  return defineConfig({
    ...ANTELOPE_STYLE,
    ...tailwind,
    ...overrides,
    ignorePatterns: [
      ...IGNORE_PATTERNS,
      ...AGENT_IGNORE_PATTERNS,
      ...ignorePatterns,
    ],
  });
}
