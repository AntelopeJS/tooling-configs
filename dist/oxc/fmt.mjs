import { n as IGNORE_PATTERNS, t as AGENT_IGNORE_PATTERNS } from "../shared-DYvliWWW.mjs";
import { defineConfig } from "oxfmt";
//#region src/oxc/fmt.ts
/**
* The house style. Every field is set explicitly, including the ones that match
* oxfmt's own defaults: repositories carry `.editorconfig` files that disagree
* with each other (five declare tabs, two declare spaces), and oxfmt falls back
* to `.editorconfig` for any field a config leaves unset. Stating all of them
* is what makes the style the same everywhere.
*/
const ANTELOPE_STYLE = {
	printWidth: 80,
	tabWidth: 2,
	useTabs: false,
	semi: true,
	singleQuote: false,
	trailingComma: "all"
};
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
function antelopeFmtPreset(options = {}) {
	const { tailwindStylesheet, ignorePatterns = [], ...overrides } = options;
	const tailwind = tailwindStylesheet === void 0 ? {} : { sortTailwindcss: {
		stylesheet: tailwindStylesheet,
		functions: ["clsx", "cn"]
	} };
	return defineConfig({
		...ANTELOPE_STYLE,
		...tailwind,
		...overrides,
		ignorePatterns: [
			...IGNORE_PATTERNS,
			...AGENT_IGNORE_PATTERNS,
			...ignorePatterns
		]
	});
}
//#endregion
export { ANTELOPE_STYLE, antelopeFmtPreset };
