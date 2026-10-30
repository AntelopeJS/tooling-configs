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
	],
	invalid: [
		{ code: "function parse(value: unknown): void {}", errors: [error] },
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
			name: "dms-mailing src/services/send.ts:162 named error helper outside .catch",
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
