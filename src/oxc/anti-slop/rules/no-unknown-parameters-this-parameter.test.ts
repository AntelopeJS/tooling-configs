import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownParameter" };

const BRAND = `const BRAND = Symbol.for("b");
type Branded = { [BRAND]?: string };
`;

tester.run("anti-slop/no-unknown-parameters at a same-file callee declaring a this parameter", noUnknownParametersRule, {
	valid: [
		{
			name: "a guard declaring this: void: fails one that reads the predicate subject at the argument index of the this parameter",
			code: `function isText(this: void, value: unknown): value is string { return typeof value === "string"; }
export function parse(input: unknown): string {
  if (isText(input)) return input;
  throw new Error("not text");
}`,
		},
		{
			name: "a forward to a callee declaring this: void: fails one that reads the callee parameter at the argument index of the this parameter",
			code: `function describe(this: void, input: unknown): string { return String(input); }
export function label(config: unknown): string { return describe(config); }`,
		},
		{
			name: "a brand probe through a guard and a reader declaring this: void: fails one that follows the probe into the this parameter",
			code: `${BRAND}function isObj(this: void, v: unknown): v is object { return typeof v === "object" && v !== null; }
function readBrand(this: void, v: Branded): string | undefined { return v[BRAND]; }
export function hasBrand(value: unknown): boolean {
  return isObj(value) && readBrand(value) !== undefined;
}`,
		},
		{
			name: "a callback declaring this: void handed only caught values: fails one that reads the unknown position at the index of the this parameter",
			code: "export function run(onError: (this: void, error: unknown) => void): void { try { work(); } catch (caught) { onError(caught); } }",
		},
		{
			name: "a .catch handler declaring this: void: fails one that takes the this parameter for the rejection reason",
			code: "export const done = work().catch(function (this: void, error: unknown) { log(error); });",
		},
		{
			name: "a reject type declaring this: void: fails one that counts the this parameter toward its arity",
			code: "export type Settle = { reject: (this: void, reason: unknown) => void };",
		},
		{
			name: "a promise executor declaring this: void with a reject not named reject: fails one that takes resolve for the reject position",
			code: "export const ready = new Promise<number>(function (this: void, resolve, fail: (reason: unknown) => void) { go(resolve, fail); });",
		},
	],
	invalid: [
		{
			name: "an argument beside the subject of a guard declaring this: void: fails one that shifts the argument onto the predicate subject",
			code: `function isText(this: void, value: unknown, label: unknown): value is string { return typeof value === "string"; }
export function parse(input: unknown): string {
  if (isText("x", input)) return input;
  throw new Error("not text");
}`,
			errors: [
				{ ...error, line: 1 },
				{ ...error, line: 2 },
			],
		},
		{
			name: "a forward beside an exempt parameter of a callee declaring this: void: fails one that shifts the argument onto the exempt parameter",
			code: `function describe(this: void, input: unknown, extra: unknown): string { stash(extra); return String(input); }
export function label(config: unknown): string { return describe("x", config); }`,
			errors: [
				{ ...error, line: 1 },
				{ ...error, line: 2 },
			],
		},
		{
			name: "a brand probe handing the value to a reader beside the parameter a this: void reader reads: fails one that shifts the argument onto the read parameter",
			code: `${BRAND}function isObj(v: unknown): v is object { return typeof v === "object" && v !== null; }
function readBrand(this: void, v: Branded, other: object): string | undefined { keep(other); return v[BRAND]; }
export function hasBrand(value: unknown): boolean {
  return isObj(value) && readBrand({}, value) !== undefined;
}`,
			errors: [{ ...error, line: 5 }],
		},
	],
});
