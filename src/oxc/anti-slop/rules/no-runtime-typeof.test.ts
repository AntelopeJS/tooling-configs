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
	],
});
