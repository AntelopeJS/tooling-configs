import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownParameter" };

const GUARDS = 'import { isString } from "./guards";\n';
const IS_STRING = "function isString(v: unknown): v is string { return typeof v === 'string'; }\n";
const STORE = "const store: unknown[] = [];\n";

tester.run("anti-slop/no-unknown-parameters at the bounds of a guard-only classifier", noUnknownParametersRule, {
	valid: [
		{
			name: "an imported isString returned as is: fails one that refuses a return under a precise guard",
			code: `${GUARDS}function label(value: unknown): string { if (isString(value)) return value; return ""; }`,
		},
		{
			name: "typeof string returned through ?:: fails one that grades every typeof as loose",
			code: "function label(value: unknown): string { return typeof value === 'string' ? value : ''; }",
		},
		{
			name: "a same-file predicate joined by && to typeof object: fails one that lets the looser test of an && decide",
			code: "interface Options { name?: string }\nfunction isOptions(v: unknown): v is Options { return v !== null; }\nfunction toOptions(value: unknown): Options { if (typeof value === 'object' && isOptions(value)) return value; return {}; }",
		},
		{
			name: "a length read under Array.isArray: fails one that refuses every read under a loose test",
			code: "function count(value: unknown): number { if (Array.isArray(value)) return value.length; return 0; }",
		},
		{
			name: "a narrowed read in an object-literal method after an exiting guard: fails one that stops narrowing at every nested function",
			code: `${GUARDS}function size(value: unknown): number { if (!isString(value)) return 0; const view = { length() { return value.length; } }; return view.length(); }`,
		},
		{
			name: "recursion in a function with a this parameter: fails one that counts the this parameter in the argument position",
			code: "function label(this: void, value: unknown, deep: boolean): string { if (typeof value === 'string') return value; if (deep) return label(value, false); return JSON.stringify(value); }",
		},
	],
	invalid: [
		{
			name: "an Array.isArray-narrowed value returned as string[]: fails one that trusts every type test as precise",
			code: "function toTags(value: unknown): string[] { if (Array.isArray(value)) return value; return []; }",
			errors: [error],
		},
		{
			name: "an instanceof-narrowed value returned as Map<string, number>: fails one that grades only Array.isArray as loose",
			code: "function toCounts(value: unknown): Map<string, number> { if (value instanceof Map) return value; return new Map(); }",
			errors: [error],
		},
		{
			name: "a typeof object-narrowed value returned as a weak type: fails one that grades only guard calls and instanceof as loose",
			code: "interface Options { name?: string }\nfunction toOptions(value: unknown): Options { if (typeof value === 'object' && value !== null) return value; return {}; }",
			errors: [error],
		},
		{
			name: "a value returned after an exiting typeof object guard: fails one that grades branches but not exiting guards",
			code: "type Foo = { a?: string };\nfunction obj(x: unknown): Foo { if (typeof x !== 'object' || x === null) throw new Error(); return x; }",
			errors: [error],
		},
		{
			name: "a typeof function-narrowed value called: fails one that refuses only returns",
			code: "function run(value: unknown): number { if (typeof value === 'function') return value(); return 0; }",
			errors: [error],
		},
		{
			name: "a typeof function-narrowed value constructed: fails one that refuses only call expressions",
			code: "function make(value: unknown): object { if (typeof value === 'function') return new value(); return {}; }",
			errors: [error],
		},
		{
			name: "a typeof object-narrowed value assigned to a typed binding: fails one that refuses only returns and calls",
			code: "type Foo = { a?: string };\nfunction f(x: unknown): Foo { let y: Foo = {}; if (typeof x === 'object' && x !== null) { y = x; } return y; }",
			errors: [error],
		},
		{
			name: "a typeof object-narrowed value assigned to a member: fails one that refuses only assignments to a name",
			code: "type Foo = { a?: string };\nfunction keep(target: { foo: Foo }, x: unknown): Foo { if (typeof x === 'object' && x !== null) target.foo = x; return target.foo; }",
			errors: [{ ...error, data: { parameter: "x" } }],
		},
		{
			name: "an arrow's expression body under ?:: fails one that follows only return statements",
			code: "const toTags = (value: unknown): string[] => (Array.isArray(value) ? value : []);",
			errors: [error],
		},
		{
			name: "a loosely narrowed value returned through && and ||: fails one that stops at the first logical operator",
			code: "function toTags(value: unknown): string[] { return (Array.isArray(value) && value) || []; }",
			errors: [error],
		},
		{
			name: "a loosely narrowed value held in an unannotated const: fails one that lets a const alias launder it",
			code: "function toTags(value: unknown): string[] { if (!Array.isArray(value)) return []; const tags = value; return tags; }",
			errors: [error],
		},
		{
			name: "a loosely narrowed value awaited and returned: fails one that stops at await",
			code: "async function toTags(value: unknown): Promise<string[]> { if (Array.isArray(value)) return await value; return []; }",
			errors: [error],
		},
		{
			name: "a loosely narrowed value yielded: fails one that refuses only returns and assignments",
			code: "function* toTags(value: unknown): Generator<string[]> { if (Array.isArray(value)) yield value; }",
			errors: [error],
		},
		{
			name: "node:util isDeepStrictEqual with two arguments: fails one that trusts every imported isX as a guard",
			code: "import { isDeepStrictEqual } from 'node:util';\nconst seen: unknown[] = [];\nfunction remember(value: unknown, previous: string): string { if (isDeepStrictEqual(value, previous)) { seen.push(value); return 'same'; } return typeof value; }",
			errors: [{ ...error, data: { parameter: "value" } }],
		},
		{
			name: "lodash isEqual(x, 1) guarding a store: fails one that refuses only isDeepStrictEqual by name",
			code: `import { isEqual } from 'lodash';\n${STORE}function keep(x: unknown): string { if (isEqual(x, 1)) store.push(x); return typeof x; }`,
			errors: [error],
		},
		{
			name: "a read in a function declaration called above an exiting guard: fails one that lets an exiting guard narrow a hoisted declaration",
			code: "const sink: unknown[] = [];\nfunction label(value: unknown): string { record(); if (typeof value !== 'string') throw new TypeError('x'); function record() { sink.push(value); } return value; }",
			errors: [error],
		},
		{
			name: "a nested declaration after a negated predicate passing the value to any: fails one that judges a declaration by where it is called",
			code: `declare function other(v: any): void;\n${IS_STRING}export function f(x: unknown): { a?: string } { if (!isString(x)) return {}; function inner() { other(x); } inner(); return {}; }`,
			errors: [{ ...error, data: { parameter: "x" } }],
		},
		{
			name: "a read in a block function declaration inside a guarded branch: fails one that stops only exiting-guard narrowing at declarations",
			code: `${IS_STRING}${STORE}export function f(x: unknown): string { if (isString(x)) { function keep() { store.push(x); } keep(); } return ''; }`,
			errors: [{ ...error, data: { parameter: "x" } }],
		},
		{
			name: "a read in a class method inside a guarded branch: fails one that lets narrowing enter a class body",
			code: `${IS_STRING}${STORE}export function f(x: unknown): string { if (isString(x)) { class C { m() { store.push(x); } } new C().m(); } return ''; }`,
			errors: [{ ...error, data: { parameter: "x" } }],
		},
		{
			name: "a read in a class property initializer after an exiting guard: fails one that stops only at class methods",
			code: `${IS_STRING}${STORE}export function f(x: unknown): number { if (!isString(x)) return 0; class Holder { kept = store.push(x); } return new Holder().kept; }`,
			errors: [{ ...error, data: { parameter: "x" } }],
		},
		{
			name: "a read in a class getter after an exiting guard: fails one that stops only at methods and initializers",
			code: `${IS_STRING}${STORE}export function f(x: unknown): number { if (!isString(x)) return 0; class Holder { get kept() { return store.push(x); } } return new Holder().kept; }`,
			errors: [{ ...error, data: { parameter: "x" } }],
		},
		{
			name: "a type predicate on another parameter: fails one that counts only boolean and void as verdicts",
			code: "export function f(x: unknown, y: string): y is 'a' { return typeof x === 'string' && y === 'a'; }",
			errors: [{ ...error, data: { parameter: "x" } }],
		},
		{
			name: "an asserts clause on another parameter: fails one that counts only predicates that do not assert",
			code: "export function f(x: unknown, y: string): asserts y is 'a' { return typeof x === 'string' && y === 'a'; }",
			errors: [{ ...error, data: { parameter: "x" } }],
		},
		{
			name: "true | false: fails one that counts only the boolean keyword as a verdict",
			code: "function f(x: unknown): true | false { return typeof x === 'string'; }",
			errors: [error],
		},
		{
			name: "the parameter passed back to the function itself at another position: fails one that accepts recursion at any position",
			code: `${IS_STRING}type Foo = { a?: string };\nfunction f(x: unknown, y: any): Foo { if (isString(x)) {} return f(y, x); }`,
			errors: [{ ...error, data: { parameter: "x" } }],
		},
		{
			name: "a cast around ??: fails one that looks for a cast only on the read's own parent",
			code: "interface Config { name?: string }\nfunction toConfig(value: unknown): Config { if (typeof value !== 'object') return {}; return (value ?? {}) as Config; }",
			errors: [error],
		},
		{
			name: "a cast around a ?: branch: fails one that skips the branches a value flows out through",
			code: "interface Config { name?: string }\nfunction toConfig(value: unknown, ok: boolean): Config { if (typeof value !== 'object') return {}; return (ok ? value : {}) as Config; }",
			errors: [error],
		},
		{
			name: "a non-null assertion around ||: fails one that checks only as for a wrapped cast",
			code: "function toTags(value: unknown): string[] { if (!Array.isArray(value)) return []; return (value || null)!; }",
			errors: [error],
		},
		{
			name: "boolean | undefined: fails one that lets a nullable member turn a verdict into a value",
			code: "function isEnabled(value: unknown): boolean | undefined { return typeof value === 'string' ? true : undefined; }",
			errors: [error],
		},
		{
			name: "boolean | null: fails one that accepts only undefined beside a verdict",
			code: "function isEnabled(value: unknown): boolean | null { return typeof value === 'string' ? true : null; }",
			errors: [error],
		},
	],
});
