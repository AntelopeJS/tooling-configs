import { RuleTester } from "oxlint/plugins-dev";

import { noRuntimeTypeofRule } from "./no-runtime-typeof.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "runtimeTypeof" };
const constructorError = { messageId: "constructorCheck" };
const allowInTypeGuards = [{ allowInTypeGuards: true }];

tester.run("anti-slop/no-runtime-typeof", noRuntimeTypeofRule, {
	valid: [
		'const isServer = typeof document === "undefined";',
		'const hasStorage = typeof localStorage !== "undefined";',
		'if (typeof globalThis.crypto === "undefined") throw new Error("no crypto");',
		'const missing = "undefined" === typeof process;',
		"const value = input;",
		{
			code: 'function isString(value: unknown): value is string { return typeof value === "string"; }',
			options: allowInTypeGuards,
		},
		{
			code: 'const isString = (value: unknown): value is string => typeof value === "string";',
			options: allowInTypeGuards,
		},
		{
			code: 'function assertString(value: unknown): asserts value is string { if (typeof value !== "string") throw new Error(); }',
			options: allowInTypeGuards,
		},
		"if (error.constructor === ValidationError) report(error);",
		"const plain = value.constructor === Object;",
		{
			code: 'const isText = (value: unknown): value is string => value?.constructor === String && value !== "";',
			options: allowInTypeGuards,
		},
		{
			name: "agent-skills scripts/lib/values.mjs:3 isText with a JSDoc predicate",
			filename: "values.mjs",
			code: '/**\n * Whether `value` is a string.\n * @param {unknown} value\n * @returns {value is string}\n */\nexport function isText(value) {\n  return typeof value === "string";\n}',
			options: allowInTypeGuards,
		},
		{
			name: "agent-skills scripts/lib/values.mjs:8 isRecord with a JSDoc predicate",
			filename: "values.mjs",
			code: '/** @returns {value is Record<string, unknown>} */\nfunction isRecord(value) { return typeof value === "object" && value !== null; }',
			options: allowInTypeGuards,
		},
		{
			filename: "guards.js",
			code: '/** @returns {value is string} */\nconst isText = (value) => typeof value === "string";',
			options: allowInTypeGuards,
		},
		{
			filename: "guards.js",
			code: 'const guards = {\n  /** @returns {value is string} */\n  isText(value) { return typeof value === "string"; },\n};',
			options: allowInTypeGuards,
		},
	],
	invalid: [
		{ code: 'if (typeof input === "string") use(input);', errors: [error] },
		{ code: "if (typeof input === undefined) use(input);", errors: [error] },
		{
			code: 'function isString(value: unknown): value is string { return typeof value === "string"; }',
			errors: [error],
		},
		{
			code: 'function parse(value: unknown): string { if (typeof value !== "string") throw new Error(); return value; }',
			options: allowInTypeGuards,
			errors: [error],
		},
		{
			code: 'function isString(value: unknown): value is string { const check = () => typeof value === "string"; return check(); }',
			options: allowInTypeGuards,
			errors: [error],
		},
		{
			name: "cloud #379 check-locales.mjs isText",
			code: 'function isText(value) { return value?.constructor === String && value !== ""; }',
			options: allowInTypeGuards,
			errors: [constructorError],
		},
		{
			name: "cloud #379 check-locales.mjs statedTextKeys",
			code: "const keys = entries.flatMap((entry) => entry.value?.constructor === String && entry.value.startsWith(MARKER) ? [entry.value] : []);",
			options: allowInTypeGuards,
			errors: [constructorError],
		},
		{ code: "if (Number !== count.constructor) throw new Error();", errors: [constructorError] },
		{ code: "const flag = value.constructor == Boolean;", errors: [constructorError] },
		{
			name: "a JSDoc predicate needs allowInTypeGuards",
			filename: "values.mjs",
			code: '/** @returns {value is string} */\nfunction isText(value) { return typeof value === "string"; }',
			errors: [error],
		},
		{
			name: "a JSDoc predicate only counts in .js and .mjs files",
			filename: "values.ts",
			code: '/** @returns {value is string} */\nfunction isText(value: unknown) { return typeof value === "string"; }',
			options: allowInTypeGuards,
			errors: [error],
		},
		{
			name: "a JSDoc boolean return is not a predicate",
			filename: "values.mjs",
			code: '/** @returns {boolean} whether value is string */\nfunction isText(value) { return typeof value === "string"; }',
			options: allowInTypeGuards,
			errors: [error],
		},
		{
			name: "a JSDoc predicate must name a parameter",
			filename: "values.mjs",
			code: '/** @returns {other is string} */\nfunction isText(value) { return typeof value === "string"; }',
			options: allowInTypeGuards,
			errors: [error],
		},
		{
			name: "a JSDoc predicate covers only the function it documents",
			filename: "values.mjs",
			code: '/** @returns {value is string} */\nfunction isText(value) { return true; }\nfunction parse(value) { return typeof value === "string"; }',
			options: allowInTypeGuards,
			errors: [error],
		},
		{
			name: "a JSDoc predicate does not cover a callback inside the guard",
			filename: "values.mjs",
			code: '/** @returns {value is string[]} */\nfunction isTexts(value) { return Array.isArray(value) && value.every((item) => typeof item === "string"); }',
			options: allowInTypeGuards,
			errors: [error],
		},
	],
});
