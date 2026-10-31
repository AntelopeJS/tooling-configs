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
			name: "dms-automation@29b56c5 src/runtime/builtins/nodes/foreach.ts:15 a log message",
			code: 'async function execute() { if (!Array.isArray(raw)) { ctx.log("warn", `foreach "items" input is not an array (got ${typeof raw}); iterating zero times`); } }',
		},
		{
			name: "mongodb@cf32203 src/implementations/database/utils.ts:63 a thrown message",
			code: "if (!isString(id)) { throw new Error(`Invalid instance id: expected string, got ${typeof id}`); }",
		},
		{
			name: "a logger's log call records the message",
			code: "function f(value: unknown) { console.log(`got ${typeof value}`); }",
		},
		{
			name: "an assert call with the message in a branch of a conditional",
			code: "function f(value: unknown) { assert(ok(value), flag ? `got ${typeof value}` : 'bad'); }",
		},
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
			name: "postgres@887faab src/implementations/database/writes-shared.ts:159 text returned to a caller that can compare it",
			code: 'export function DescribeKind(value: unknown): string { return Array.isArray(value) ? "an array" : `a ${typeof value}`; }',
			errors: [error],
		},
		{
			name: "a message returned by an arrow can be compared by its caller",
			code: "const describeKind = (value: unknown): string => `a ${typeof value}`;",
			errors: [error],
		},
		{
			name: "a message returned inside an object can be compared by its caller",
			code: "function describe(value: unknown) { return { kind: `a ${typeof value}` }; }",
			errors: [error],
		},
		{
			name: "a message tested by Set#has steers an if",
			code: 'const KINDS = new Set(["kind:string"]);\nfunction f(value: unknown): number { if (KINDS.has(`kind:${typeof value}`)) return 1; return 2; }',
			errors: [error],
		},
		{
			name: "a message tested by Object.hasOwn is a lookup",
			code: "function f(value: unknown): boolean { return Object.hasOwn(KINDS, `kind:${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a message tested by includes steers an if",
			code: "function f(value: unknown): number { if (NAMES.includes(`kind:${typeof value}`)) return 1; return 2; }",
			errors: [error],
		},
		{
			name: "a message tested by RegExp#test steers an if",
			code: "function f(value: unknown): number { return /^kind:string$/.test(`kind:${typeof value}`) ? 1 : 2; }",
			errors: [error],
		},
		{
			name: "a message handed to a call whose result is tested",
			code: "function f(value: unknown): number { return isKnown(`kind:${typeof value}`) ? 1 : 2; }",
			errors: [error],
		},
		{
			name: "a message inside the argument of a call that is itself an argument",
			code: "function f(value: unknown) { use(known(flag ? `kind:${typeof value}` : other)); }",
			errors: [error],
		},
		{
			name: "a message handed to a call whose result is bound",
			code: "function f(value: unknown) { const known = KINDS.has(`kind:${typeof value}`); return known; }",
			errors: [error],
		},
		{
			name: "a message handed to an awaited call",
			code: "async function f(value: unknown) { await dispatch(`kind:${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a message handed to a call chained on",
			code: "function f(value: unknown) { assertKnown(`kind:${typeof value}`).then(done); }",
			errors: [error],
		},
		{
			name: "an error built from a message and kept, not thrown",
			code: "function f(value: unknown) { const failure = new Error(`received ${typeof value}`); return failure; }",
			errors: [error],
		},
		{
			name: "an error built from a message and returned, which its caller can read",
			code: "function failureFor(value: unknown) { return new Error(`received ${typeof value}`); }",
			errors: [error],
		},
		{
			name: "an error built from a message and rejected through a call",
			code: "function f(value: unknown) { return Promise.reject(new Error(`received ${typeof value}`)); }",
			errors: [error],
		},
		{
			name: "an object built from a message as a statement",
			code: "function f(value: unknown) { new Lookup(`kind:${typeof value}`); }",
			errors: [error],
		},
		{
			name: "assert.equal compares the message with a literal",
			code: 'import assert from "node:assert";\nexport function requireString(value: string | number): void { assert.equal(`kind:${typeof value}`, "kind:string"); }',
			errors: [error],
		},
		{
			name: "assert.strictEqual compares the message with a literal",
			code: 'import assert from "node:assert";\nexport function requireStrict(value: string | number): void { assert.strictEqual(`kind:${typeof value}`, "kind:string", "expected a string"); }',
			errors: [error],
		},
		{
			name: "assert.ok is a member of assert, not assert itself",
			code: 'import assert from "node:assert";\nexport function f(value: unknown): void { assert.ok(`kind:${typeof value}`); }',
			errors: [error],
		},
		{
			name: "a Set that records the message and is asked about it later",
			code: 'const seen = new Set<string>();\nexport function isStringLike(value: string | number): boolean { seen.clear(); seen.add(`kind:${typeof value}`); return seen.has("kind:string"); }',
			errors: [error],
		},
		{
			name: "an array that records the message and is asked about it later",
			code: 'export function f(value: unknown): boolean { const kinds: string[] = []; kinds.push(`kind:${typeof value}`); return kinds.includes("kind:string"); }',
			errors: [error],
		},
		{
			name: "an emitter that routes on the message",
			code: "export function f(value: unknown): void { bus.emit(`on:${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a local dispatcher that routes on the message",
			code: 'function route(kind: string): void { if (kind === "kind:string") go(); }\nexport function f(value: unknown): void { route(`kind:${typeof value}`); }',
			errors: [error],
		},
		{
			name: "a bare call to any name other than assert is not a message sink",
			code: "export function f(value: unknown): void { check(`kind:${typeof value}`); }",
			errors: [error],
		},
		{
			name: "console.warn is not on the list of message sinks",
			code: "export function f(value: unknown): void { console.warn(`got ${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a bare log call is not a log method",
			code: "export function f(value: unknown): void { log(`got ${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a log method reached by a computed name",
			code: 'export function f(value: unknown): void { ctx["log"](`got ${typeof value}`); }',
			errors: [error],
		},
		{
			name: "a log method reached through an optional chain",
			code: "export function f(value: unknown): void { ctx?.log(`got ${typeof value}`); }",
			errors: [error],
		},
		{
			name: "an assert message that is the typeof result alone",
			code: "export function f(value: unknown, ok: boolean): void { assert(ok, `${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a thrown template that is the typeof result alone",
			code: "export function f(value: unknown): void { throw `${typeof value}`; }",
			errors: [error],
		},
		{
			name: "a thrown message used as a condition",
			code: "export function f(value: unknown): void { throw `a ${typeof value}` ? one : two; }",
			errors: [error],
		},
		{
			name: "a log method reached by a computed identifier",
			code: "export function f(value: unknown): void { ctx[log](`got ${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a call whose callee is itself a call",
			code: "export function f(value: unknown): void { factory()(`k:${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a super call takes the message",
			code: "export class A extends B { constructor(value: unknown) { super(`k:${typeof value}`); } }",
			errors: [error],
		},
		{
			name: "a tagged template stands as a statement",
			code: "export function f(value: unknown): void { handle`k:${typeof value}`; }",
			errors: [error],
		},
		{
			name: "a call under a logical and stands in an expression, not as a statement",
			code: "export function f(value: unknown): void { handler && handler(`k:${typeof value}`); }",
			errors: [error],
		},
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
