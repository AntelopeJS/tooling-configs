import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownParameter" };

const LOOSE = "interface P { readonly id: string }\nfunction loose(value: any): P { return value; }\n";
const IMPORTED = `import { settings } from "./settings";\n${LOOSE}`;
const OWN_PARSER = "{ parse: (v: any): P => v }";

tester.run("anti-slop/no-unknown-parameters at a parse boundary, what `this` is and which name an element or an unresolved name stands for", noUnknownParametersRule, {
	valid: [
		{
			name: "this in an arrow inside a method is the class",
			code: `${IMPORTED}class Registry { codec = settings; read() { return (value: unknown): P => this.codec.parse(value); } }`,
		},
		{
			name: "this in an arrow field is the class",
			code: `${IMPORTED}class Registry { codec = settings; read = (value: unknown): P => this.codec.parse(value); }`,
		},
		{
			name: "this in an accessor is the class",
			code: `${IMPORTED}class Registry { codec = settings; get reader() { return (value: unknown): P => this.codec.parse(value); } }`,
		},
		{
			name: "a private field and a public field of one name are two elements, the public one read",
			code: `${IMPORTED}class Registry { codec = settings; #codec = ${OWN_PARSER}; read(value: unknown): P { return this.codec.parse(value); } }`,
		},
		{
			name: "a private field and a public field of one name are two elements, the private one read",
			code: `${IMPORTED}class Registry { codec = ${OWN_PARSER}; #codec = settings; read(value: unknown): P { return this.#codec.parse(value); } }`,
		},
		{
			name: "a parameter property beside a private field of one name, the public one read",
			code: `${LOOSE}class Registry { #codec = ${OWN_PARSER}; constructor(private codec: Codec) {} read(value: unknown): P { return this.codec.parse(value); } }`,
		},
		{
			name: "an instance method reads the parameter property beside a static field of one name",
			code: `${LOOSE}class Registry { static codec = ${OWN_PARSER}; constructor(readonly codec: Codec) {} read(value: unknown): P { return this.codec.parse(value); } }`,
		},
		{
			name: "a global nothing in the file writes",
			code: `${LOOSE}export function readUser(value: unknown): P { return codec.parse(value); }`,
		},
		{
			name: "a global declared and never written",
			code: `${LOOSE}declare global { var codec: Codec; }\nexport function readUser(value: unknown): P { return codec.parse(value); }`,
		},
		{
			name: "a global read outside the namespace that happens to declare a member of that name",
			code: `${LOOSE}namespace Users { export const codec = ${OWN_PARSER}; }\nexport function readUser(value: unknown): P { return codec.parse(value); }`,
		},
	],
	invalid: [
		{
			name: "this in a method of an object literal beside a class field of that name",
			code: `${IMPORTED}class Registry { codec = settings; make() { return { codec: ${OWN_PARSER}, readUser(value: unknown): P { return this.codec.parse(value); } }; } }`,
			errors: [error],
		},
		{
			name: "this in a function expression inside a method",
			code: `${IMPORTED}class Registry { codec = settings; make() { return function (this: { codec: Codec }, value: unknown): P { return this.codec.parse(value); }; } }`,
			errors: [error],
		},
		{
			name: "this in a function declaration inside a method",
			code: `${IMPORTED}class Registry { codec = settings; make() { function readUser(this: { codec: Codec }, value: unknown): P { return this.codec.parse(value); } return readUser; } }`,
			errors: [error],
		},
		{
			name: "this in a function expression held by a field",
			code: `${IMPORTED}class Registry { codec = settings; readUser = function (this: { codec: Codec }, value: unknown): P { return this.codec.parse(value); }; }`,
			errors: [error],
		},
		{
			name: "this in a method of an object literal inside an arrow inside a method",
			code: `${IMPORTED}class Registry { codec = settings; make() { return () => ({ codec: ${OWN_PARSER}, readUser(value: unknown): P { return this.codec.parse(value); } }); } }`,
			errors: [error],
		},
		{
			name: "a private field read as the public field of that name",
			code: `${IMPORTED}class Registry { codec = ${OWN_PARSER}; #codec = settings; read(value: unknown): P { return this.codec.parse(value); } }`,
			errors: [error],
		},
		{
			name: "a public field read as the private field of that name",
			code: `${IMPORTED}class Registry { codec = settings; #codec = ${OWN_PARSER}; read(value: unknown): P { return this.#codec.parse(value); } }`,
			errors: [error],
		},
		{
			name: "a private field read as a parameter property of that name",
			code: `${LOOSE}class Registry { #codec = ${OWN_PARSER}; constructor(private codec: Codec) {} read(value: unknown): P { return this.#codec.parse(value); } }`,
			errors: [error],
		},
		{
			name: "a static method reads the static field, not a parameter property of that name",
			code: `${LOOSE}class Registry { constructor(readonly codec: Codec) {} static codec = ${OWN_PARSER}; static read(value: unknown): P { return this.codec.parse(value); } }`,
			errors: [error],
		},
		{
			name: "a static method finds only a parameter property of that name",
			code: `${LOOSE}class Registry { constructor(readonly codec: Codec) {} static read(value: unknown): P { return this.codec.parse(value); } }`,
			errors: [error],
		},
		{
			name: "a field and a parameter property of one name",
			code: `${IMPORTED}class Registry { codec = settings; constructor(readonly codec: Codec) {} read(value: unknown): P { return this.codec.parse(value); } }`,
			errors: [error],
		},
		{
			name: "a callee merged from another namespace block, in a cycle",
			code: `interface P { readonly id: string }
export namespace Users { export function parseA(value: unknown): P { return parseB(value); } }
export namespace Users { export function parseB(value: unknown): P { return parseA(value); } }`,
			errors: [error, error],
		},
		{
			name: "a member merged from another namespace block",
			code: `${LOOSE}export namespace Users { export const codec = ${OWN_PARSER}; }
export namespace Users { export function readUser(value: unknown): P { return codec.parse(value); } }`,
			errors: [error],
		},
		{
			name: "a member merged from another block of the legacy module spelling",
			code: `${LOOSE}module Users { export const codec = ${OWN_PARSER}; }
module Users { export function readUser(value: unknown): P { return codec.parse(value); } }`,
			errors: [error],
		},
		{
			name: "a function merged from another namespace block, handed over in an object",
			code: `import { define } from "./shared";
${LOOSE}export namespace Users { export function readUser(value: unknown): P { return define({ parse: later }).parse(value); } }
export namespace Users { export function later(value: any): P { return value; } }`,
			errors: [error],
		},
		{
			name: "a global read inside a namespace, which may be a member of another block",
			code: `${LOOSE}namespace Users { export function readUser(value: unknown): P { return codec.parse(value); } }`,
			errors: [error],
		},
		{
			name: "a global the file assigns",
			code: `${LOOSE}declare global { var codec: Codec; }
codec = ${OWN_PARSER};
export function readUser(value: unknown): P { return codec.parse(value); }`,
			errors: [error],
		},
		{
			name: "a global the file assigns in a function",
			code: `${LOOSE}function install(): void { codec = ${OWN_PARSER}; }
export function readUser(value: unknown): P { return codec.parse(value); }`,
			errors: [error],
		},
		{
			name: "a global the file destructures into",
			code: `${LOOSE}[codec] = [${OWN_PARSER}];
export function readUser(value: unknown): P { return codec.parse(value); }`,
			errors: [error],
		},
		{
			name: "a bare callee that is a global the file assigns",
			code: `${LOOSE}parse = loose;
export function readUser(value: unknown): P { return parse(value); }`,
			errors: [error],
		},
	],
});
