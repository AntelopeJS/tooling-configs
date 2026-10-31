import { RuleTester } from "oxlint/plugins-dev";

import { noRuntimeTypeofRule } from "./no-runtime-typeof.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "runtimeTypeof" };
const constructorError = { messageId: "constructorCheck" };
const allowInTypeGuards = [{ allowInTypeGuards: true }];

tester.run("anti-slop/no-runtime-typeof", noRuntimeTypeofRule, {
	valid: [
		{
			name: "postgres@887faab src/implementations/database/selection.ts:114 an assert message",
			code: 'assert(id === undefined || id === null || IsString(id), `An instance id must be a string or CROSS_INSTANCE, received ${typeof id}`);',
		},
		{
			name: "postgres@887faab src/implementations/database/stages-selection.ts:89 an assert message",
			code: "assert(IsString(name), `The '${stage.stage}' stage names its index with a string, received ${typeof name}`);",
		},
		{
			name: "postgres@887faab src/implementations/database/stages-selection.ts:130 a branch of a nested message",
			code: "assert(Array.isArray(key) && key.length === columns.length, `The '${selection.indexId}' index takes a key of ${columns.length} values, received ${Array.isArray(key) ? `${key.length} values` : `a ${typeof key}`}`);",
		},
		{
			name: "postgres@887faab src/implementations/database/utils.ts:79 a thrown message",
			code: "if (!IsString(id)) { throw new Error(`${operation} expects a string instance id, received ${typeof id}`); }",
		},
		{
			name: "postgres@887faab src/implementations/database/value.ts:83 a thrown message",
			code: "throw new Error(`Unsupported value of type '${typeof value}' in query`);",
		},
		{
			name: "postgres@887faab src/implementations/database/writes-insert.ts:95 an assert message",
			code: "assert(IsString(supplied), `An inserted document's '${ID_COLUMN}' must be a string, received ${typeof supplied}`);",
		},
		{
			name: "postgres@887faab src/implementations/database/writes-shared.ts:159 text returned for the refusal",
			code: 'export function DescribeKind(value: unknown): string { return Array.isArray(value) ? "an array" : `a ${typeof value}`; }',
		},
		{
			name: "mongodb@cf32203 src/implementations/database/utils.ts:63 a thrown message",
			code: "if (!isString(id)) { throw new Error(`Invalid instance id: expected string, got ${typeof id}`); }",
		},
		"const describeKind = (value: unknown): string => `a ${typeof value}`;",
		"throw `received ${typeof value}`;",
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
		{
			name: "a message compared to a value is a check",
			code: 'if (`a ${typeof input}` === "a string") use(input);',
			errors: [error],
		},
		{
			name: "a message bound to a name can be compared later",
			code: "const kind = `a ${typeof input}`;",
			errors: [error],
		},
		{
			name: "a message assigned to a name can be compared later",
			code: "kind = `a ${typeof input}`;",
			errors: [error],
		},
		{
			name: "a message switched on is a check",
			code: "switch (`a ${typeof input}`) { default: break; }",
			errors: [error],
		},
		{
			name: "a message used as a condition is a check",
			code: "use(`a ${typeof input}` ? one : two);",
			errors: [error],
		},
		{
			name: "a message used as a lookup key is a check",
			code: "const handler = handlers[`a ${typeof input}`];",
			errors: [error],
		},
		{
			name: "a tagged template can branch on its values",
			code: "tag`a ${typeof input}`;",
			errors: [error],
		},
		{
			name: "a template with no text is the typeof result itself",
			code: "use(`${typeof input}`);",
			errors: [error],
		},
		{
			name: "a typeof passed to a call is not message text",
			code: "use(typeof input);",
			errors: [error],
		},
		{
			name: "a comparison inside a template is a check",
			code: 'throw new Error(`a ${typeof input === "string" ? "text" : "other"}`);',
			errors: [error],
		},
		{
			name: "a typeof bound to a name can be compared later",
			code: "const kind = typeof input;",
			errors: [error],
		},
		{
			name: "a returned typeof is not message text",
			code: "function kindOf(input: unknown): string { return typeof input; }",
			errors: [error],
		},
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
