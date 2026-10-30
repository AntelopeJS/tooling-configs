import { RuleTester } from "oxlint/plugins-dev";

import { noUnsafeDictionaryTypeRule } from "./no-unsafe-dictionary-type.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

const error = { messageId: "unsafeDictionary" };

tester.run("anti-slop/no-unsafe-dictionary-type", noUnsafeDictionaryTypeRule, {
	valid: [
		"type Commands = Record<string, Command>;",
		"type Metadata = Record<PropertyKey, JsonValue>;",
		"type PermissionLevels = Record<Permission, number>;",
		"type Indexed = { [key: string]: Command };",
		"type CompatibleIndexes = { [index: number]: Command; [key: string]: Command | OtherCommand };",
		"type Exhaustive = { [K in Permission]: number };",
		"type Allowed = Record<string, { payload: unknown }>;",
		"type AlsoAllowed = Record<string, Result<Data, unknown>>;",
		"type Index<T> = Record<string, T>; type EntityIndex<T extends Entity> = Record<string, T>;",
		"type Safe = Index<Command>; type Index<T> = Record<string, T>;",
		"type A = Map<string, unknown>; type B = ReadonlyMap<string, unknown>; type C = WeakMap<object, unknown>;",
		"import { Record } from './local'; type A = Record<string, unknown>;",
		"type Record<K, V> = { key: K; value: V }; type A = Record<string, unknown>;",
		"type Readonly<T> = { value: T }; type A = Record<string, Readonly<unknown>>;",
		"type NonNullable<T> = { value: T }; type A = Record<string, NonNullable<unknown>>;",
		"type Value<T> = T; type Index<T = Command, U = Value<T>> = Record<string, U>; type A = Index;",
		"interface Owner { readonly id: string } type A = Record<string, unknown & Owner>;",
		"interface Owner { readonly id: string } interface Child extends Owner {} type A = Record<string, Child>;",
		"interface Owner { readonly id: string } interface Child extends Owner { readonly __brand?: never } type A = Record<string, Child>;",
		"interface Escape {} interface Escape { readonly id: string } type A = Record<string, Escape>;",
		"interface Escape { readonly id: string } interface Escape {} type A = Record<string, Escape>;",
		"interface Owner { readonly id: string } type A = Record<string, object & Owner>;",
		"type Wrap<T> = { readonly wrapped: T }; type Inner<T, U> = { readonly value: T } & Wrap<U>; type Outer<T, U> = Record<string, Inner<T, U>>; declare function f<T, U>(): Outer<T, U>;",
		"type WithSchema<T extends Record<string, unknown>> = (schema: T) => void;",
		"function run<T extends Record<string, unknown>>(input: T): T { return input; }",
		"declare class Store<T extends Record<string, unknown>> { read(): T }",
		"type Deep<T extends Readonly<Record<string, unknown>>> = T;",
		{
			name: "interface-database-decorators@fc2cead src/model.ts:66 predicate target",
			code: 'function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }',
		},
		"const isRecord = (value: unknown): value is Record<string, unknown> => value !== null;",
		"type IsRecord = (value: unknown) => value is Record<string, unknown>;",
		{
			name: "cloud@f784b41 src/secrets/transit.ts:228 inside a type-guard body",
			code: 'function isEnvelopeFields(value: unknown): value is TransitEnvelopeFields { if (!value || typeof value !== "object") return false; const fields = value as Record<string, unknown>; return typeof fields.iv === "string"; }',
		},
	],
	invalid: [
		{ code: "type A = Record<string, unknown>;", errors: [error] },
		{ code: "type A = { [key: string]: any };", errors: [error] },
		{ code: "type A = { [index: number]: Command; [key: string]: unknown | Command };", errors: 1 },
		{ code: "type A = { [K in PropertyKey]: object };", errors: [error] },
		{ code: "type A = { [K in PropertyKey]: NonNullable<unknown> };", errors: [error] },
		{ code: "type A = { [key: string]: NonNullable<unknown> };", errors: [error] },
		{ code: "type A = Record<string, {}>;", errors: [error] },
		{ code: "interface Escape {} type A = Record<string, Escape>;", errors: [error] },
		{
			code: "interface Escape { readonly __brand?: never } type A = Record<string, Escape>;",
			errors: [error],
		},
		{
			code: "type Escape = { readonly __brand?: never }; type A = Record<string, Escape>;",
			errors: [error],
		},
		{ code: "type A = Record<string, { readonly __brand?: never }>;", errors: [error] },
		{ code: "type A = Record<string, string | unknown>;", errors: [error] },
		{ code: "interface Escape {} type A = Record<string, string | Escape>;", errors: [error] },
		{ code: "type A = Record<string, unknown & {}>;", errors: [error] },
		{
			code: "interface Owner { readonly id: string } type A = Record<string, any & Owner>;",
			errors: [error],
		},
		{ code: "type Escape = unknown; type A = Record<string, Escape>;", errors: [error] },
		{ code: "type Dict = Record<string, unknown>;", errors: [error] },
		{ code: "type A = Readonly<Partial<Required<(Record<string, unknown>)>>>;", errors: [error] },
		{ code: "type A = { readonly [key: string]: unknown };", errors: [error] },
		{ code: "type A = { readonly [K in string]: unknown };", errors: [error] },
		{ code: "type Source = Record<string, unknown>; type A = Pick<Source, string>;", errors: 2 },
		{ code: "type Source = Record<string, unknown>; type A = Omit<Source, never>;", errors: 2 },
		{ code: "type Index<T> = Record<string, T>; type A = Index<unknown>;", errors: 1 },
		{ code: "interface A { [key: string]: unknown }", errors: [error] },
		{ code: "type A = Readonly<Record<string, unknown>>;", errors: 1 },
		{ code: "type A = Record<string, Readonly<unknown>>;", errors: [error] },
		{ code: "type A = Record<string, Partial<unknown>>;", errors: [error] },
		{ code: "type A = Record<string, Required<unknown>>;", errors: [error] },
		{ code: "type Escape = Readonly<unknown>; type A = Record<string, Escape>;", errors: 1 },
		{
			code: "type Wrapped<T> = Readonly<T>; type A = Record<string, Wrapped<unknown>>;",
			errors: 1,
		},
		{ code: "type A = Record<string, NonNullable<unknown>>;", errors: [error] },
		{ code: "type Escape = NonNullable<unknown>; type A = Record<string, Escape>;", errors: 1 },
		{
			code: "type Unsafe = Record<string, unknown>; const x: Unsafe = {}; const y: Unsafe = {};",
			errors: 1,
		},
		{
			code: "type Unsafe = Record<string, unknown>; type AlsoUnsafe = Unsafe; const x: Unsafe = {};",
			errors: 2,
		},
		{ code: "type Index<T = unknown> = Record<string, T>; type A = Index;", errors: 1 },
		{
			code: "type Index<T, U = T> = Record<string, U>; type A = Index<string, unknown>;",
			errors: 1,
		},
		{ code: "type Index<T, U = T> = Record<string, U>; type A = Index<unknown>;", errors: 1 },
		{
			code: "type Value<T> = T; type Index<T, U = Value<T>> = Record<string, U>; type A = Index<unknown>;",
			errors: 1,
		},
		{
			code: "type Marker<T> = { readonly __brand?: never }; type Index<T, U = Marker<T>> = Record<string, U>; type A = Index<Item>;",
			errors: 1,
		},
		{
			code: "function outer() { type Identity<T> = T; type A = Record<string, Identity<unknown>>; }",
			errors: 1,
		},
		{
			code: "function local() { type Record<K, V> = { key: K; value: V }; type A = Record<string, unknown>; } function global() { type A = Record<string, unknown>; }",
			errors: 1,
		},
		{
			name: "Record<string, unknown> outside a type guard still flags",
			code: "function read(value: object): string { const fields = value as Record<string, unknown>; return String(fields.id); }",
			errors: [error],
		},
		{
			name: "a type guard's parameter is not its body",
			code: "function isEntry(value: Record<string, unknown>): value is Entry { return true; }",
			errors: [error],
		},
		{
			name: "a function nested in a type guard is not the guard",
			code: "function isEntry(value: unknown): value is Entry { const read = (raw: object) => raw as Record<string, unknown>; return read(value) !== null; }",
			errors: [error],
		},
		{
			name: "another unsafe dictionary as a predicate target still flags",
			code: "function isBag(value: unknown): value is Record<string, any> { return true; }",
			errors: [error],
		},
		{
			name: "a predicate target nested in a wider type still flags",
			code: "function isBags(value: unknown): value is Array<Record<string, unknown>> { return true; }",
			errors: [error],
		},
	],
});
