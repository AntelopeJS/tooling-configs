import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownParameter" };

const LOOSE = "interface P { readonly id: string }\nfunction loose(value: any): P { return value; }\n";
const CALL = "export function parseUser(value: unknown): P { return ";

tester.run("anti-slop/no-unknown-parameters at a parse boundary, callee roots built by a call", noUnknownParametersRule, {
	valid: [
		{
			name: "a const schema built from a shape const of imported schemas",
			code: `import { z } from "zod";
const shape = { id: z.string() };
const userSchema = z.object(shape);
function parseUser(value: unknown): User { return userSchema.parse(value); }`,
		},
		{
			name: "a schema built with options whose values are plain data",
			code: `import { Type } from "@sinclair/typebox";
const userSchema = Type.Object({ id: Type.String() }, { additionalProperties: false });
function parseUser(value: unknown): User { return userSchema.parse(value); }`,
		},
		{
			name: "a schema built from a nested call that takes a local refinement",
			code: `import { z } from "zod";
const idsSchema = z.array(z.string().refine((id) => id.length > 0));
function parseIds(value: unknown): string[] { return idsSchema.parse(value); }`,
		},
		{
			name: "aliases of each other in a loop hold no function",
			code: `import { define } from "./define";
const a = b;
const b = a;
const codec = define(a);
function parseUser(value: unknown): User { return codec.parse(value); }`,
		},
		{
			name: "a schema built from a local function by an imported factory",
			code: `import { custom } from "./schemas";
function isUser(candidate: unknown): candidate is User { return isRecord(candidate); }
const userSchema = custom(isUser);
function parseUser(value: unknown): User { return userSchema.parse(value); }`,
		},
		{
			name: "a schema built from a declared constant with no initializer",
			code: `import { define } from "./define";
declare const shared: Codec;
const codec = define(shared);
function parseUser(value: unknown): User { return codec.parse(value); }`,
		},
	],
	invalid: [
		{
			name: "a frozen object of local functions that call each other through it",
			code: `${LOOSE}function parseA(value: unknown): P { return codec.parseB(value); }
function parseB(value: unknown): P { return codec.parseA(value); }
const codec = Object.freeze({ parseA, parseB });`,
			errors: [error, error],
		},
		{
			name: "a frozen object whose property is a local binding of a loose function",
			code: `${LOOSE}const codec = Object.freeze({ parseUser: loose });\n${CALL}codec.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "an object assembled by Object.assign from a local binding",
			code: `${LOOSE}const codec = Object.assign({}, { parseUser: loose });\n${CALL}codec.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a frozen object that holds an inline arrow",
			code: `interface P { readonly id: string }\nconst codec = Object.freeze({ parseUser: (v: any): P => v });\n${CALL}codec.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a frozen object that holds a nested object of local functions",
			code: `${LOOSE}const codec = Object.freeze({ inner: { parseUser: loose } });\n${CALL}codec.inner.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a frozen object that spreads an object of local functions",
			code: `${LOOSE}const base = { parseUser: loose };\nconst codec = Object.freeze({ ...base });\n${CALL}codec.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a frozen local object const",
			code: `${LOOSE}const base = { parseUser: loose };\nconst codec = Object.freeze(base);\n${CALL}codec.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a frozen local class",
			code: `interface P { readonly id: string }\nclass Own { static parseUser(v: any): P { return v; } }\nconst codec = Object.freeze(Own);\n${CALL}codec.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "an imported factory handed an object that holds a local function",
			code: `import { define } from "./define";\n${LOOSE}const codec = define({ parseUser: loose });\n${CALL}codec.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a frozen object that holds a method",
			code: `interface P { readonly id: string }\nconst codec = Object.freeze({ parseUser(v: any): P { return v; } });\n${CALL}codec.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a frozen object that holds a class expression",
			code: `interface P { readonly id: string }\nconst codec = Object.freeze({ own: class { static parseUser(v: any): P { return v; } } });\n${CALL}codec.own.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a frozen object that holds a local class by shorthand",
			code: `interface P { readonly id: string }\nclass own { static parseUser(v: any): P { return v; } }\nconst codec = Object.freeze({ own });\n${CALL}codec.own.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a frozen object that holds a const arrow",
			code: `interface P { readonly id: string }\nconst loose = (v: any): P => v;\nconst codec = Object.freeze({ parseUser: loose });\n${CALL}codec.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a frozen object that holds a member of a local object",
			code: `${LOOSE}const base = { parseUser: loose };\nconst codec = Object.freeze({ parseUser: base.parseUser });\n${CALL}codec.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a frozen object that holds the result of a local factory",
			code: `interface P { readonly id: string }\nfunction make() { return (v: any): P => v; }\nconst codec = Object.freeze({ parseUser: make() });\n${CALL}codec.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a frozen object that holds an instance of a local class",
			code: `interface P { readonly id: string }\nclass Own { parseUser(v: any): P { return v; } }\nconst codec = Object.freeze({ own: new Own() });\n${CALL}codec.own.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a frozen class expression",
			code: `interface P { readonly id: string }\nconst codec = Object.freeze(class { static parseUser(v: any): P { return v; } });\n${CALL}codec.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a frozen result of a frozen call",
			code: `${LOOSE}const codec = Object.freeze(Object.freeze({ parseUser: loose }));\n${CALL}codec.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a frozen member of a local object",
			code: `${LOOSE}const base = { inner: { parseUser: loose } };\nconst codec = Object.freeze(base.inner);\n${CALL}codec.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a frozen choice between local objects",
			code: `${LOOSE}const base = { parseUser: loose };\nconst codec = Object.freeze(flag ? base : other);\n${CALL}codec.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a frozen fallback to a local object",
			code: `${LOOSE}const base = { parseUser: loose };\nconst codec = Object.freeze(maybe ?? base);\n${CALL}codec.parseUser(value); }`,
			errors: [error],
		},
	],
});
