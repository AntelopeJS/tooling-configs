import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownParameter" };

const LOOSE = "interface P { readonly id: string }\nfunction loose(value: any): P { return value; }\n";
const OWN = `${LOOSE}const own = { parse: loose };\n`;

tester.run("anti-slop/no-unknown-parameters at a parse boundary, where a bound name gets its value", noUnknownParametersRule, {
	valid: [
		{
			name: "a parameter default that is an import",
			code: `import { shared } from "./shared";
function parseWith(value: unknown, codec = shared): User { return codec.parse(value); }`,
		},
		{
			name: "a destructuring default that is an import, from an import",
			code: `import { fallback, settings } from "./settings";
const { codec = fallback } = settings;
function parseUser(value: unknown): User { return codec.parse(value); }`,
		},
		{
			name: "a destructured parameter whose default is an import",
			code: `import { shared } from "./shared";
function parseWith(value: unknown, { codec = shared }: Options): User { return codec.parse(value); }`,
		},
		{
			name: "an array pattern default that is an import",
			code: `import { shared, list } from "./shared";
const [codec = shared] = list;
function parseUser(value: unknown): User { return codec.parse(value); }`,
		},
		{
			name: "a parameter default built by an imported factory",
			code: `import { makeCodec } from "./shared";
function parseWith(value: unknown, codec = makeCodec()): User { return codec.parse(value); }`,
		},
		{
			name: "a parameter default that is another parameter",
			code: "function parseWith(value: unknown, first: Codec, codec = first): User { return codec.parse(value); }",
		},
		{
			name: "a parameter assigned an import",
			code: `import { shared } from "./shared";
function parseWith(value: unknown, codec: Codec): User { codec = shared; return codec.parse(value); }`,
		},
		{
			name: "an import-equals alias of a member of an imported namespace",
			code: `import * as schemas from "./schemas";
import user = schemas.user;
function parseUser(value: unknown): User { return user.parse(value); }`,
		},
		{
			name: "an import-equals alias of an imported namespace",
			code: `import * as schemas from "./schemas";
import alias = schemas;
function parseUser(value: unknown): User { return alias.user.parse(value); }`,
		},
		{
			name: "a parameter assigned from another parameter",
			code: `function parseWith(value: unknown, first: Codec, codec: Codec): User { codec = first; return codec.parse(value); }`,
		},
		{
			name: "an import-equals alias of a require",
			code: `import loaded = require("./loaded");
import alias = loaded.codec;
function parseUser(value: unknown): User { return alias.parse(value); }`,
		},
		{
			name: "an inner parameter that shadows a local object",
			code: `${OWN}function parseWith(value: unknown, own: Codec): P { return own.parse(value); }`,
		},
	],
	invalid: [
		{
			name: "a parameter default that is a local object",
			code: `${OWN}function parseWith(value: unknown, codec = own): P { return codec.parse(value); }`,
			errors: [error],
		},
		{
			name: "a parameter default that is an inline local object",
			code: `${LOOSE}function parseWith(value: unknown, codec = { parse: loose }): P { return codec.parse(value); }`,
			errors: [error],
		},
		{
			name: "a parameter default that is a frozen local object",
			code: `${OWN}function parseWith(value: unknown, codec = Object.freeze({ parse: loose })): P { return codec.parse(value); }`,
			errors: [error],
		},
		{
			name: "a parameter default that aliases a local object",
			code: `${OWN}const alias = own;
function parseWith(value: unknown, codec = alias): P { return codec.parse(value); }`,
			errors: [error],
		},
		{
			name: "a parameter default built by a local factory",
			code: `${LOOSE}function make() { return { parse: loose }; }
function parseWith(value: unknown, codec = make()): P { return codec.parse(value); }`,
			errors: [error],
		},
		{
			name: "a destructured parameter whose member defaults to a local object",
			code: `${OWN}function parseWith(value: unknown, { codec = own }: Options): P { return codec.parse(value); }`,
			errors: [error],
		},
		{
			name: "a destructured parameter whose whole default is a local object",
			code: `${OWN}function parseWith(value: unknown, { codec }: Options = { codec: own }): P { return codec.parse(value); }`,
			errors: [error],
		},
		{
			name: "a renamed member of a destructured parameter that defaults to a local object",
			code: `${OWN}function parseWith(value: unknown, { schema: codec = own }: Options): P { return codec.parse(value); }`,
			errors: [error],
		},
		{
			name: "a nested pattern in a parameter that defaults to a local object",
			code: `${OWN}function parseWith(value: unknown, { inner: { codec = own } }: Options): P { return codec.parse(value); }`,
			errors: [error],
		},
		{
			name: "an array pattern parameter that defaults to a local object",
			code: `${OWN}function parseWith(value: unknown, [codec = own]: Codec[]): P { return codec.parse(value); }`,
			errors: [error],
		},
		{
			name: "an arrow parameter that defaults to a local object, read by a closure",
			code: `${OWN}const parseWith = (codec = own) => (value: unknown): P => codec.parse(value);`,
			errors: [error],
		},
		{
			name: "a destructuring default that is a local object, from an empty frozen object",
			code: `${OWN}const { codec = own } = Object.freeze<{ codec?: typeof own }>({});
function parseUser(value: unknown): P { return codec.parse(value); }`,
			errors: [error],
		},
		{
			name: "a destructuring default that is a local object, from an import",
			code: `${OWN}import { settings } from "./settings";
const { codec = own } = settings;
function parseUser(value: unknown): P { return codec.parse(value); }`,
			errors: [error],
		},
		{
			name: "a renamed destructuring default that is a local object",
			code: `${OWN}import { settings } from "./settings";
const { schema: codec = own } = settings;
function parseUser(value: unknown): P { return codec.parse(value); }`,
			errors: [error],
		},
		{
			name: "a nested destructuring default that is a local object",
			code: `${OWN}import { settings } from "./settings";
const { inner: { codec = own } } = settings;
function parseUser(value: unknown): P { return codec.parse(value); }`,
			errors: [error],
		},
		{
			name: "an array destructuring default that is a local object",
			code: `${OWN}import { list } from "./settings";
const [codec = own] = list;
function parseUser(value: unknown): P { return codec.parse(value); }`,
			errors: [error],
		},
		{
			name: "a parameter assigned a local object",
			code: `${OWN}function parseWith(value: unknown, codec: Codec): P { codec = own; return codec.parse(value); }`,
			errors: [error],
		},
		{
			name: "a parameter assigned a local object under a logical assignment",
			code: `${OWN}function parseWith(value: unknown, codec?: Codec): P { codec ??= own; return codec.parse(value); }`,
			errors: [error],
		},
		{
			name: "a parameter redeclared by var as a local object",
			code: `${OWN}function parseWith(value: unknown, codec: Codec): P { var codec = own; return codec.parse(value); }`,
			errors: [error],
		},
		{
			name: "a parameter updated in a way that has no assigned expression",
			code: `${OWN}function parseWith(value: unknown, codec: Codec): P { codec++; return codec.parse(value); }`,
			errors: [error],
		},
		{
			name: "an import-equals alias of a local namespace, read by a member",
			code: `interface P { readonly id: string }
namespace First {
  export function parseA(value: unknown): P { return SecondAlias.parseB(value); }
}
namespace Second {
  export function parseB(value: unknown): P { return FirstAlias.parseA(value); }
}
import FirstAlias = First;
import SecondAlias = Second;`,
			errors: [error, error],
		},
		{
			name: "an import-equals alias of a function in a local namespace, called bare",
			code: `interface P { readonly id: string }
namespace N {
  export function parseUser(value: any): P { return value; }
}
import parseUser = N.parseUser;
export function readUser(value: unknown): P { return parseUser(value); }`,
			errors: [error],
		},
		{
			name: "an exported import-equals alias of a local namespace",
			code: `interface P { readonly id: string }
namespace N {
  export const codec = { parse: (v: any): P => v };
}
export import alias = N;
export function parseUser(value: unknown): P { return alias.codec.parse(value); }`,
			errors: [error],
		},
		{
			name: "an import-equals alias of a nested local namespace",
			code: `interface P { readonly id: string }
namespace Outer {
  export namespace Inner {
    export const codec = { parse: (v: any): P => v };
  }
}
import inner = Outer.Inner;
export function parseUser(value: unknown): P { return inner.codec.parse(value); }`,
			errors: [error],
		},
		{
			name: "a parameter assigned through destructuring assignment",
			code: `${OWN}function parseWith(value: unknown, codec: Codec): P { [codec] = [own]; return codec.parse(value); }`,
			errors: [error],
		},
		{
			name: "a parameter assigned in a branch",
			code: `${OWN}function parseWith(value: unknown, codec: Codec, flag: boolean): P { if (flag) { codec = own; } return codec.parse(value); }`,
			errors: [error],
		},
		{
			name: "a default that reads an earlier default",
			code: `${OWN}function parseWith(value: unknown, first = own, codec = first): P { return codec.parse(value); }`,
			errors: [error],
		},
		{
			name: "a catch binding destructured with a local default",
			code: `${OWN}function parseWith(value: unknown): P { try { throw 1; } catch ({ codec = own }) { return codec.parse(value); } }`,
			errors: [error],
		},
		{
			name: "an import-equals alias of a class merged with a namespace",
			code: `interface P { readonly id: string }
class K { static parse(v: any): P { return v; } }
namespace K { export const x = 1; }
import Alias = K;
export function parseUser(value: unknown): P { return Alias.parse(value); }`,
			errors: [error],
		},
		{
			name: "a const alias of an import-equals alias of a local namespace",
			code: `interface P { readonly id: string }
namespace N { export const codec = { parse: (v: any): P => v }; }
import A = N.codec;
const B = A;
export function parseUser(value: unknown): P { return B.parse(value); }`,
			errors: [error],
		},
	],
});
