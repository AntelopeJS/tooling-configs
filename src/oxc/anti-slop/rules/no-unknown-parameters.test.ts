import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownParameter" };

tester.run("anti-slop/no-unknown-parameters", noUnknownParametersRule, {
	valid: [
		"function enrich(cause: unknown): void {}",
		"function enrich(cause: Error | unknown): void {}",
		"function isString(value: unknown): value is string { return true; }",
		"const isString = (value: unknown): value is string => true;",
		"function assertString(value: unknown): asserts value is string {}",
		"type Guard = (value: unknown) => value is string;",
		"declare function isString(value: unknown): value is string;",
		"type Guards = { isString(value: unknown): value is string };",
		"function parse(value: string | number): void {}",
		{
			name: "dms-database@9d4c3a2 src/routes/tables.ts:208 @Parameter query values",
			code: 'class Tables { async source(@AuthRawUser() user: User, @Parameter("filter_scope", "query") scope: unknown, @Parameter("filter_q", "query") q: unknown) {} }',
		},
		{
			name: "api@6ca9d0f playground/src/index.ts:25 @JSONBody() body",
			code: 'class Playground { async update(@JSONBody() body: unknown) {} }',
		},
		{
			name: "interface-api route-decorators.ts @JSONBody without a call",
			code: "class Users { async create(@JSONBody body: unknown) {} }",
		},
		{
			name: "dms-lang@48b888a src/routes/translations.ts:337 @JsonBody() body",
			code: "class Translations { async upsert(@JsonBody() body: unknown) {} }",
		},
		{
			name: "dms-marketing@db43b56 src/data-api/tenant-scope.ts:29 this parameter",
			code: "const scoped = { func: async function (this: unknown, ctx: RequestContext) {} };",
		},
		"function bound(this: unknown): void {}",
		"type Bound = (this: unknown) => void;",
		{
			name: "dms-saas@8021a7e src/crons/recompute-segments.ts:10 .catch callback",
			code: "void recomputeAllSegments().catch((error: unknown) => { Logging.Error('failed', error); });",
		},
		"promise.catch(function (reason: unknown) { report(reason); });",
		"promise?.catch((reason: unknown) => reason);",
		{
			name: "mongodb@41c1535 src/schema-initialization.ts:171 .then onRejected",
			code: "attempt.then(() => handleSuccess(task), (error: unknown) => handleFailure(task, error, controller.signal));",
		},
		{
			name: "mongodb@41c1535 src/test/schema-initialization-helpers.ts:9 declared reject property",
			code: "interface Deferred<Value> { promise: Promise<Value>; resolve: (value: Value) => void; reject: (error: unknown) => void; }",
		},
		{
			name: "mongodb@41c1535 src/test/schema-initialization-helpers.ts:21 declared reject binding",
			code: "let reject!: (error: unknown) => void;",
		},
		{
			name: "dms-frontend@49bfafa tests/vue-async-data-fetch.test.mts:260 reject in a type literal",
			code: "const answers = new Map<string, { resolve: (value: string) => void; reject: (reason: unknown) => void }>();",
		},
		"const done = new Promise<void>((resolve, fail: (reason?: unknown) => void) => { fail(new Error()); });",
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
		{
			name: "interface-database-decorators@ca92201 src/model.ts:171 Model.validate narrows its input with a type guard",
			code: "class Model { static validate(obj: unknown, options?: ValidateInputOptions): ValidationResult { const record = isRecord(obj) ? obj : undefined; return check(record, options); } }",
		},
		{
			name: "a validator guarding each use with && and if",
			code: "function name(value: unknown): string | undefined { if (isRecord(value)) return isNamed(value) && value.name; return undefined; }",
		},
		"const decodeUser = (input: unknown) => User.decode(input);",
		"function readConfig(input: unknown) { return ConfigSchema.safeParse(input); }",
	],
	invalid: [
		{ code: "function parse(value: unknown): void {}", errors: [error] },
		{
			name: "a body that reads the parameter without narrowing it: fails one that exempts any parameter the body reads",
			code: "function log(value: unknown): void { console.log(value); }",
			errors: [{ ...error, data: { parameter: "value" } }],
		},
		{
			name: "a use after the guarded branch: fails one that exempts a parameter once any guard call reads it",
			code: "function save(value: unknown): void { if (isRecord(value)) store(value); send(value); }",
			errors: [{ ...error, data: { parameter: "value" } }],
		},
		{
			name: "a use in the branch the guard makes false: fails one that accepts either branch",
			code: "const pick = (value: unknown) => (isRecord(value) ? undefined : value);",
			errors: [{ ...error, data: { parameter: "value" } }],
		},
		{
			name: "a call outside a test position: fails one that counts any call as a guard",
			code: "function forward(value: unknown) { const sent = send(value); return sent; }",
			errors: [{ ...error, data: { parameter: "value" } }],
		},
		{
			name: "a declared validate signature has no body to narrow: fails one that matches the method name",
			code: "interface Validator { validate(obj: unknown): ValidationResult }",
			errors: [{ ...error, data: { parameter: "obj" } }],
		},
		{ code: "function parse(value: string | unknown): void {}", errors: [error] },
		{
			code: "function parse(value: string | (number | unknown)): void {}",
			errors: [error],
		},
		{
			code: "function isString(value: unknown, context: unknown): value is string { return true; }",
			errors: [{ ...error, data: { parameter: "context" } }],
		},
		{
			code: "export function parse({ value }: unknown = {}): void {}",
			errors: [{ ...error, data: { parameter: "{ value }" } }],
		},
		{
			name: "a parameter decorator outside the boundary list still flags",
			code: "class Users { async create(@Body() body: unknown, @Context() ctx: unknown) {} }",
			errors: [{ ...error, data: { parameter: "body" } }, { ...error, data: { parameter: "ctx" } }],
		},
		{
			name: "MultiParameter is not on the boundary list",
			code: 'class Posts { list(@MultiParameter("tag", "query") tags: unknown) {} }',
			errors: [{ ...error, data: { parameter: "tags" } }],
		},
		{
			name: "a this parameter does not exempt the parameters after it",
			code: "function bound(this: unknown, value: unknown): void {}",
			errors: [{ ...error, data: { parameter: "value" } }],
		},
		{
			name: "a named error helper outside .catch: its name exempts nothing",
			code: "const describeError = (error: unknown): string => String(error);",
			errors: [{ ...error, data: { parameter: "error" } }],
		},
		{
			name: "a parameter named reason outside .catch still flags",
			code: "function onRejected(reason: unknown): void {}",
			errors: [{ ...error, data: { parameter: "reason" } }],
		},
		{
			name: "a handler passed to .catch by name is checked where it is declared",
			code: "const handler = (reason: unknown) => reason; promise.catch(handler);",
			errors: [{ ...error, data: { parameter: "reason" } }],
		},
		{
			name: "the onFulfilled callback of .then still flags",
			code: "promise.then((reason: unknown) => reason);",
			errors: [{ ...error, data: { parameter: "reason" } }],
		},
		{
			name: "only the rejection reason of a .catch callback is exempt",
			code: "promise.catch((reason: unknown, extra: unknown) => reason);",
			errors: [{ ...error, data: { parameter: "extra" } }],
		},
		{
			name: "a callback nested inside a .catch callback still flags",
			code: "promise.catch(() => items.map((reason: unknown) => reason));",
			errors: [{ ...error, data: { parameter: "reason" } }],
		},
		{
			name: "a .finally callback still flags",
			code: "promise.finally((reason: unknown) => reason);",
			errors: [{ ...error, data: { parameter: "reason" } }],
		},
		{
			name: "a function type bound to another name still flags",
			code: "let onError!: (reason: unknown) => void;",
			errors: [{ ...error, data: { parameter: "reason" } }],
		},
		{
			name: "a reject type that returns a value still flags",
			code: "interface Deferred { reject: (reason: unknown) => Promise<void> }",
			errors: [{ ...error, data: { parameter: "reason" } }],
		},
	],
});
