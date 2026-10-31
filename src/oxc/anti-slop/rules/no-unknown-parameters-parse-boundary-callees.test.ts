import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownParameter" };

tester.run("anti-slop/no-unknown-parameters at a parse boundary, callees and implicit reads", noUnknownParametersRule, {
	valid: [
		{
			name: "a callee imported from another module is checked where it is declared",
			code: `import { DecodeValue } from "./value";
function Decoded(value: unknown): Compiled { return DecodeValue(value); }`,
		},
		{
			name: "a decoder imported from a package",
			code: `import { parse } from "valibot";
function parseUser(value: unknown): User { return parse(userSchema, value); }`,
		},
		{
			name: "a decoder reached through a namespace import",
			code: `import * as v from "valibot";
function parseUser(value: unknown): User { return v.parse(userSchema, value); }`,
		},
		{
			name: "a schema declared in the same file is the decoder, not a wrapper around one",
			code: `const userSchema = z.object({ id: z.string() });
function parseUser(value: unknown): User { return userSchema.parse(value); }`,
		},
		{
			name: "a schema built by a call with plain fields in the same file",
			code: `const userSchema = z.object({ id: z.string(), name: z.string().min(1) });
function parseUser(value: unknown): User { return userSchema.parse(value); }`,
		},
		{
			name: "a schema held in a field of this",
			code: "class Users { constructor(private readonly schema: Schema) {} parse(value: unknown): User { return this.schema.parse(value); } }",
		},
		{
			name: "arguments read in a sibling function does not refuse this one",
			code: "function parseUser(value: unknown): User { return userSchema.parse(value); }\nfunction forward() { return sink(arguments[0]); }",
		},
	],
	invalid: [
		{
			name: "two decoder-named functions that call each other decode nothing",
			code: `export function parseA(value: unknown): Parsed { return parseB(value); }
export function parseB(value: unknown): Parsed { return parseA(value); }`,
			errors: [error, error],
		},
		{
			name: "a decoder-named function that calls itself decodes nothing",
			code: "export function parseSelf(value: unknown): Parsed { return parseSelf(value); }",
			errors: [error],
		},
		{
			name: "a decoder-named wrapper over a function declared in the same file",
			code: `function decodeStore(value: unknown): Parsed { return value as Parsed; }
function read(value: unknown): Parsed { return decodeStore(value); }`,
			errors: [error, error],
		},
		{
			name: "a decoder-named arrow bound to a const in the same file",
			code: `const parseA = (value: unknown): Parsed => parseB(value);
const parseB = (value: unknown): Parsed => parseA(value);`,
			errors: [error, error],
		},
		{
			name: "a decoder-named callee passed in as a parameter",
			code: "function read(parse: Decoder, value: unknown): Parsed { return parse(value); }",
			errors: [error],
		},
		{
			name: "methods of one class that call each other through this",
			code: `class Parsers {
  parseA(value: unknown): Parsed { return this.parseB(value); }
  parseB(value: unknown): Parsed { return this.parseA(value); }
}`,
			errors: [error, error],
		},
		{
			name: "a static method of a class declared in the same file",
			code: `class Parsers { static parseA(value: unknown): Parsed { return Parsers.parseB(value); } static parseB(value: unknown): Parsed { return Parsers.parseA(value); } }`,
			errors: [error, error],
		},
		{
			name: "methods of an object literal declared in the same file",
			code: `const parsers = {
  parseA(value: unknown): Parsed { return parsers.parseB(value); },
  parseB(value: unknown): Parsed { return parsers.parseA(value); },
};`,
			errors: [error, error],
		},
		{
			name: "a method reached through super",
			code: `class Base { parseB(value: unknown): Parsed { return value as Parsed; } }
class Child extends Base { parseA(value: unknown): Parsed { return super.parseB(value); } }`,
			errors: [error, error],
		},
		{
			name: "static methods of a class expression bound to a const",
			code: `const Parsers = class { static parseA(value: unknown): Parsed { return Parsers.parseB(value); } static parseB(value: unknown): Parsed { return Parsers.parseA(value); } };`,
			errors: [error, error],
		},
		{
			name: "methods of a frozen object literal declared in the same file",
			code: `const parsers = Object.freeze({
  parseA(value: unknown): Parsed { return parsers.parseB(value); },
  parseB: (value: unknown): Parsed => parsers.parseA(value),
});`,
			errors: [error, error],
		},
		{
			name: "a method of an instance of a class declared in the same file",
			code: `class Parsers { parseB(value: unknown): Parsed { return parsers.parseA(value); } parseA(value: unknown): Parsed { return parsers.parseB(value); } }
const parsers = new Parsers();`,
			errors: [error, error],
		},
		{
			name: "the raw value read beside the decode through arguments",
			code: "function parseWithArguments(value: unknown): Parsed { console.log(arguments[0]); return schema.parse(value); }",
			errors: [error],
		},
		{
			name: "the arguments object handed on beside the decode",
			code: "function parseWithArguments(value: unknown): Parsed { sink(...arguments); return schema.parse(value); }",
			errors: [error],
		},
		{
			name: "arguments read inside a nested arrow, which shares them",
			code: "function parseWithArguments(value: unknown): Parsed { later(() => arguments[0]); return schema.parse(value); }",
			errors: [error],
		},
		{
			name: "a direct eval can read the parameter by name",
			code: "function parseWithEval(value: unknown): Parsed { sink(eval('value')); return schema.parse(value); }",
			errors: [error],
		},
	],
});
