import { n as IGNORE_PATTERNS, t as AGENT_IGNORE_PATTERNS } from "../shared-DYvliWWW.mjs";
import { defineConfig } from "oxlint";
//#region src/oxc/lint.ts
/**
* The paths the preset ignores. oxlint does not merge `ignorePatterns` across
* `extends`: a root config that declares its own **replaces** these, so spread
* them when a repository adds patterns of its own.
*
* @example
* ```ts
* export default defineConfig({
*   extends: [antelopePreset()],
*   ignorePatterns: [...ANTELOPE_IGNORE_PATTERNS, "playground/**"],
* });
* ```
*/
const ANTELOPE_IGNORE_PATTERNS = [...IGNORE_PATTERNS, ...AGENT_IGNORE_PATTERNS];
const DEFAULT_COMPLEXITY_THRESHOLDS = {
	maxParams: 5,
	maxLinesPerFunction: 120,
	maxLines: 500,
	maxDepth: 4,
	complexity: 20
};
const ANTI_SLOP_RULES = [
	"no-chained-type-assertions",
	"no-conditional-empty-object-spread",
	"no-known-value-widening",
	"no-module-mocking",
	"no-object-parameters",
	"no-reflect-apply",
	"no-reflect-get",
	"no-runtime-typeof",
	"no-shape-in-symbol-names",
	"no-unknown-parameters",
	"no-unknown-returns",
	"no-unknown-type-aliases",
	"no-unsafe-dictionary-type",
	"no-widen-then-assert",
	"require-safety-comment-for-type-assertion"
];
/** Shared empty override set, so the threshold spread is never conditional. */
const EMPTY_THRESHOLDS = {};
function severityOf(option, fallback) {
	if (option === void 0 || option === true) return fallback;
	if (option === false) return "off";
	return option;
}
function basePreset(cycleSeverity) {
	return defineConfig({
		categories: { correctness: "error" },
		ignorePatterns: ANTELOPE_IGNORE_PATTERNS,
		plugins: [
			"eslint",
			"typescript",
			"node",
			"oxc",
			"import",
			"promise"
		],
		rules: {
			"import/no-cycle": cycleSeverity,
			"import/no-self-import": "error",
			"import/no-duplicates": "error"
		}
	});
}
function antiSlopPreset(severity) {
	return defineConfig({
		jsPlugins: [{
			name: "anti-slop",
			specifier: "@antelopejs/tooling-configs/oxc/anti-slop"
		}],
		rules: Object.fromEntries(ANTI_SLOP_RULES.map((rule) => [`anti-slop/${rule}`, severity]))
	});
}
function complexityPreset(thresholds, severity) {
	return defineConfig({ rules: {
		"eslint/max-params": [severity, { max: thresholds.maxParams }],
		"eslint/max-lines-per-function": [severity, {
			max: thresholds.maxLinesPerFunction,
			skipBlankLines: true,
			skipComments: true
		}],
		"eslint/max-lines": [severity, {
			max: thresholds.maxLines,
			skipBlankLines: true,
			skipComments: true
		}],
		"eslint/max-depth": [severity, { max: thresholds.maxDepth }],
		"eslint/complexity": [severity, { max: thresholds.complexity }]
	} });
}
function importSortingPreset() {
	return defineConfig({
		jsPlugins: ["eslint-plugin-perfectionist"],
		rules: { "perfectionist/sort-imports": ["error", {
			type: "line-length",
			order: "asc",
			internalPattern: ["^@/.*", "^~/.*"],
			groups: [
				["side-effect", "side-effect-style"],
				["builtin", "external"],
				[
					"internal",
					"subpath",
					"parent",
					"sibling",
					"index",
					"style",
					"unknown"
				]
			]
		}] }
	});
}
/**
* The shared AntelopeJS oxlint preset: oxc's own defaults (the `correctness`
* category), plus import hygiene, complexity ceilings, import sorting, and the
* vendored anti-slop rules.
*
* @example
* ```ts
* // oxlint.config.ts
* import { defineConfig } from "oxlint";
* import { antelopePreset } from "@antelopejs/tooling-configs/oxc/lint";
*
* export default defineConfig({
*   extends: [antelopePreset()],
*   options: { typeAware: true },
* });
* ```
*/
function antelopePreset(options = {}) {
	const complexity = options.complexity ?? true;
	const isToggle = complexity === true || complexity === false;
	const overrides = isToggle ? EMPTY_THRESHOLDS : complexity;
	const complexityThresholds = {
		...DEFAULT_COMPLEXITY_THRESHOLDS,
		...overrides
	};
	const complexitySeverity = severityOf(isToggle ? complexity : overrides.severity ?? true, "warn");
	const antiSlopSeverity = severityOf(options.antiSlop, "warn");
	return defineConfig({
		extends: [
			basePreset(severityOf(options.importCycles, "error")),
			antiSlopSeverity === "off" ? null : antiSlopPreset(antiSlopSeverity),
			complexitySeverity === "off" ? null : complexityPreset(complexityThresholds, complexitySeverity),
			options.importSorting === false ? null : importSortingPreset()
		].filter((config) => config !== null),
		rules: { "typescript/no-floating-promises": options.typeAware === false ? "off" : "error" }
	});
}
//#endregion
export { ANTELOPE_IGNORE_PATTERNS, DEFAULT_COMPLEXITY_THRESHOLDS, antelopePreset };
