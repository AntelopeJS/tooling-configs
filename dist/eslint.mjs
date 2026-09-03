import { createConfigForNuxt } from "@nuxt/eslint-config/flat";
//#region src/eslint.ts
/**
* The shared rules for a Nuxt layer. oxlint does not lint `.vue` files yet, so
* the front end stays on ESLint, and `@nuxt/eslint` supplies the Vue and
* TypeScript rules; this only records where AntelopeJS layers differ from it.
*
* Formatting rules are deliberately absent. oxfmt formats `.vue`, and a lint
* rule that also reflows markup (`vue/max-attributes-per-line`, which eight
* layers carry today) would fight it on every save.
*/
const ANTELOPE_NUXT_RULES = {
	"import/first": "off",
	"import/order": "off",
	"vue/multi-word-component-names": "off",
	"vue/require-default-prop": "off",
	"@typescript-eslint/no-explicit-any": "off",
	"@typescript-eslint/no-empty-object-type": "off",
	"@typescript-eslint/no-unused-vars": ["error", {
		argsIgnorePattern: "^_",
		varsIgnorePattern: "^_",
		caughtErrorsIgnorePattern: "^_"
	}]
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
function antelopeNuxtConfig(options = {}) {
	return createConfigForNuxt({
		features: { tooling: true },
		dirs: { src: options.dirs ?? [] }
	}).overrideRules({
		...ANTELOPE_NUXT_RULES,
		...options.rules
	});
}
//#endregion
export { ANTELOPE_NUXT_RULES, antelopeNuxtConfig };
