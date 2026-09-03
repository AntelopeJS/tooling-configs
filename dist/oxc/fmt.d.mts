import { defineConfig } from "oxfmt";
//#region src/oxc/fmt.d.ts
type OxfmtOptions = Parameters<typeof defineConfig>[0];
/**
 * The house style. Every field is set explicitly, including the ones that match
 * oxfmt's own defaults: repositories carry `.editorconfig` files that disagree
 * with each other (five declare tabs, two declare spaces), and oxfmt falls back
 * to `.editorconfig` for any field a config leaves unset. Stating all of them
 * is what makes the style the same everywhere.
 */
declare const ANTELOPE_STYLE: {
  readonly printWidth: 80;
  readonly tabWidth: 2;
  readonly useTabs: false;
  readonly semi: true;
  readonly singleQuote: false;
  readonly trailingComma: "all";
};
interface AntelopeFmtOptions extends Partial<OxfmtOptions> {
  /**
   * Sort Tailwind classes, replacing `prettier-plugin-tailwindcss`. Pass the
   * path to the stylesheet that declares the theme, as the Nuxt layers do.
   */
  tailwindStylesheet?: string;
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
declare function antelopeFmtPreset(options?: AntelopeFmtOptions): {
  arrowParens?: import("oxfmt").ArrowParensConfig | undefined;
  bracketSameLine?: boolean | undefined;
  bracketSpacing?: boolean | undefined;
  embeddedLanguageFormatting?: import("oxfmt").EmbeddedLanguageFormattingConfig | undefined;
  endOfLine?: import("oxfmt").EndOfLineConfig | undefined;
  experimentalOperatorPosition?: import("oxfmt").OperatorPositionConfig | undefined;
  htmlWhitespaceSensitivity?: import("oxfmt").HtmlWhitespaceSensitivityConfig | undefined;
  ignorePatterns: string[];
  insertFinalNewline?: boolean | undefined;
  jsdoc?: import("oxfmt").JsdocUserConfig | undefined;
  jsxSingleQuote?: boolean | undefined;
  objectWrap?: import("oxfmt").ObjectWrapConfig | undefined;
  overrides?: import("oxfmt").OxfmtOverrideConfig[] | undefined;
  printWidth: number;
  proseWrap?: import("oxfmt").ProseWrapConfig | undefined;
  quoteProps?: import("oxfmt").QuotePropsConfig | undefined;
  semi: boolean;
  singleAttributePerLine?: boolean | undefined;
  singleQuote: boolean;
  sortImports?: import("oxfmt").SortImportsUserConfig | undefined;
  sortPackageJson?: import("oxfmt").SortPackageJsonUserConfig | undefined;
  sortTailwindcss?: import("oxfmt").SortTailwindcssUserConfig;
  svelte?: import("oxfmt").SvelteUserConfig | undefined;
  tabWidth: number;
  trailingComma: import("oxfmt").TrailingCommaConfig;
  useTabs: boolean;
  vueIndentScriptAndStyle?: boolean | undefined;
} | {
  arrowParens?: import("oxfmt").ArrowParensConfig | undefined;
  bracketSameLine?: boolean | undefined;
  bracketSpacing?: boolean | undefined;
  embeddedLanguageFormatting?: import("oxfmt").EmbeddedLanguageFormattingConfig | undefined;
  endOfLine?: import("oxfmt").EndOfLineConfig | undefined;
  experimentalOperatorPosition?: import("oxfmt").OperatorPositionConfig | undefined;
  htmlWhitespaceSensitivity?: import("oxfmt").HtmlWhitespaceSensitivityConfig | undefined;
  ignorePatterns: string[];
  insertFinalNewline?: boolean | undefined;
  jsdoc?: import("oxfmt").JsdocUserConfig | undefined;
  jsxSingleQuote?: boolean | undefined;
  objectWrap?: import("oxfmt").ObjectWrapConfig | undefined;
  overrides?: import("oxfmt").OxfmtOverrideConfig[] | undefined;
  printWidth: number;
  proseWrap?: import("oxfmt").ProseWrapConfig | undefined;
  quoteProps?: import("oxfmt").QuotePropsConfig | undefined;
  semi: boolean;
  singleAttributePerLine?: boolean | undefined;
  singleQuote: boolean;
  sortImports?: import("oxfmt").SortImportsUserConfig | undefined;
  sortPackageJson?: import("oxfmt").SortPackageJsonUserConfig | undefined;
  sortTailwindcss: {
    stylesheet: string;
    functions: string[];
  } | import("oxfmt").SortTailwindcssUserConfig;
  svelte?: import("oxfmt").SvelteUserConfig | undefined;
  tabWidth: number;
  trailingComma: import("oxfmt").TrailingCommaConfig;
  useTabs: boolean;
  vueIndentScriptAndStyle?: boolean | undefined;
};
//#endregion
export { ANTELOPE_STYLE, AntelopeFmtOptions, antelopeFmtPreset };