import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownParameter" };

const LOOSE = "interface P { readonly id: string }\nfunction loose(value: any): P { return value; }\n";
const CALL = "export function parseUser(value: unknown): P { return ";

tester.run("anti-slop/no-unknown-parameters at a parse boundary, callee roots", noUnknownParametersRule, {
	valid: [
		{
			name: "a const schema built by a call rooted at an import",
			code: `import { z } from "zod";
const userSchema = z.object({ id: z.string() });
function parseUser(value: unknown): User { return userSchema.parse(value); }`,
		},
		{
			name: "a schema refined by a local arrow is still built from an import",
			code: `import { z } from "zod";
const userSchema = z.string().refine((id) => id.length > 0);
function parseUser(value: unknown): string { return userSchema.parse(value); }`,
		},
		{
			name: "a const alias of a const schema built from an import",
			code: `import { z } from "zod";
const inner = z.object({ id: z.string() });
const userSchema = inner;
function parseUser(value: unknown): User { return userSchema.parse(value); }`,
		},
		{
			name: "a schema held in a member of an imported namespace",
			code: `import * as schemas from "./schemas";
function parseUser(value: unknown): User { return schemas.user.parse(value); }`,
		},
		{
			name: "a schema picked out of an imported object by destructuring",
			code: `import { schemas } from "./schemas";
const { user } = schemas;
function parseUser(value: unknown): User { return user.parse(value); }`,
		},
		{
			name: "a schema reached through an awaited import",
			code: `import { load } from "./schemas";
async function parseUser(value: unknown): Promise<User> { return (await load()).parse(value); }`,
		},
		{
			name: "a schema reached through a non-null assertion and a type wrapper",
			code: `import { schemas } from "./schemas";
function parseUser(value: unknown): User { return (schemas.user! as Schema<User>).parse(value); }`,
		},
		{
			name: "a schema reached through a dynamic import",
			code: `async function parseUser(value: unknown): Promise<User> { return (await import("./schemas")).user.parse(value); }`,
		},
		{
			name: "a schema reached through an optional chain on an import",
			code: `import { schemas } from "./schemas";
function parseUser(value: unknown): User { return (schemas?.user).parse(value); }`,
		},
		{
			name: "a schema reached through an import-equals binding",
			code: `import codec = require("./codec");
function parseUser(value: unknown): User { return codec.parse(value); }`,
		},
		{
			name: "a schema reached through a global require",
			code: `const codec = require("./codec");
function parseUser(value: unknown): User { return codec.parse(value); }`,
		},
		{
			name: "a choice between two imports",
			code: `import { current, legacy } from "./schemas";
function parseUser(value: unknown): User { return (flag ? current : legacy).parse(value); }`,
		},
		{
			name: "a fallback between two imports",
			code: `import { current, legacy } from "./schemas";
function parseUser(value: unknown): User { return (current ?? legacy).parse(value); }`,
		},
		{
			name: "a schema reached through a type assertion on an import",
			code: `import { schemas } from "./schemas";
function parseUser(value: unknown): User { return (<Schema<User>>schemas.user).parse(value); }`,
		},
		{
			name: "a schema reached through satisfies on an import",
			code: `import { schemas } from "./schemas";
function parseUser(value: unknown): User { return (schemas.user satisfies Schema<User>).parse(value); }`,
		},
		{
			name: "a member of a parameter is the caller's schema, as disclosed",
			code: "function parseWith(codec: Codec, value: unknown): User { return codec.parse(value); }",
		},
		{
			name: "a nested member of a parameter",
			code: "function parseWith(ctx: Context, value: unknown): User { return ctx.codec.parse(value); }",
		},
	],
	invalid: [
		{
			name: "a choice whose first branch is a local object",
			code: `import { schemas } from "./schemas";\n${LOOSE}const own = { parseUser: loose };\n${CALL}(flag ? own : schemas.user).parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a fallback whose first operand is a local object",
			code: `import { schemas } from "./schemas";\n${LOOSE}const own = { parseUser: loose };\n${CALL}(own ?? schemas.user).parseUser(value); }`,
			errors: [error],
		},
		{
			name: "an object literal under as const",
			code: `${LOOSE}const codec = { parseUser: loose } as const;\n${CALL}codec.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "an object literal under satisfies",
			code: `${LOOSE}const codec = { parseUser: loose } satisfies object;\n${CALL}codec.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "an inline arrow under as const",
			code: `interface P { readonly id: string }\nconst codec = { parseUser: (v: any): P => v } as const;\n${CALL}codec.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "an object literal under a type assertion and a non-null assertion",
			code: `${LOOSE}const codec = <Codec>{ parseUser: loose };\n${CALL}codec!.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "an object held by let",
			code: `interface P { readonly id: string }\nlet codec = { parseUser: (v: any): P => v };\n${CALL}codec.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "an instance held by let",
			code: `interface P { readonly id: string }\nclass C { parseUser(v: any): P { return v; } }\nlet c = new C();\n${CALL}c.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a schema held by var, which can be reassigned",
			code: `import { z } from "zod";\nvar userSchema = z.object({ id: z.string() });\nfunction parseUser(value: unknown): User { return userSchema.parse(value); }`,
			errors: [error],
		},
		{
			name: "a const alias of a local object",
			code: `interface P { readonly id: string }\nconst inner = { parseUser: (v: any): P => v };\nconst codec = inner;\n${CALL}codec.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a chain of const aliases that loops back on itself",
			code: `interface P { readonly id: string }\nconst a = b;\nconst b = a;\n${CALL}a.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a member of a local object",
			code: `interface P { readonly id: string }\nconst ns = { inner: { parseUser: (v: any): P => v } };\n${CALL}ns.inner.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a value this walk cannot place",
			code: `import { schemas } from "./schemas";
function parseUser(value: unknown): User { return (0, schemas.user).parse(value); }`,
			errors: [error],
		},
		{
			name: "the result of a local factory",
			code: `interface P { readonly id: string }\nfunction make() { return { parseUser: (v: any): P => v }; }\n${CALL}make().parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a const built by a local factory",
			code: `interface P { readonly id: string }\nfunction make() { return { parseUser: (v: any): P => v }; }\nconst codec = make();\n${CALL}codec.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a namespace declared in the same file",
			code: `interface P { readonly id: string }\nnamespace N { export function parseUser(v: any): P { return v; } }\n${CALL}N.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a new expression of a local class",
			code: `interface P { readonly id: string }\nclass C { parseUser(v: any): P { return v; } }\n${CALL}new C().parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a member picked out of a local object by destructuring",
			code: `interface P { readonly id: string }\nconst { parseUser: parseIt } = { parseUser: (v: any): P => v };\n${CALL}parseIt(value); }`,
			errors: [error],
		},
		{
			name: "a member picked out of a local object by destructuring, then called as a member",
			code: `interface P { readonly id: string }\nconst { codec } = { codec: { parseUser: (v: any): P => v } };\n${CALL}codec.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a const declared without an initializer",
			code: `interface P { readonly id: string }\ndeclare const codec: { parseUser(v: any): P };\n${CALL}codec.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a choice between an import and a local object",
			code: `import { schemas } from "./schemas";\n${LOOSE}const own = { parseUser: loose };\nconst codec = flag ? schemas.user : own;\n${CALL}codec.parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a fallback to a local object",
			code: `import { schemas } from "./schemas";\n${LOOSE}const own = { parseUser: loose };\n${CALL}(schemas.user ?? own).parseUser(value); }`,
			errors: [error],
		},
		{
			name: "a parameter itself called by a decoder name",
			code: "function read(parse: Decoder, value: unknown): Parsed { return parse(value); }",
			errors: [error],
		},
	],
});
