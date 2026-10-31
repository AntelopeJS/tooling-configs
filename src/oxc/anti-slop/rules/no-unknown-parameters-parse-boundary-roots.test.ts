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
			name: "a const schema built from a shape const of imported schemas",
			code: `import { z } from "zod";
const shape = { id: z.string() };
const userSchema = z.object(shape);
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
			name: "a schema handed in as a constructor parameter property",
			code: "class Users { constructor(private readonly schema: Schema) {} parse(value: unknown): User { return this.schema.parse(value); } }",
		},
		{
			name: "a schema held in a field that starts from an import",
			code: `import { z } from "zod";
class Users { private readonly schema = z.object({ id: z.string() }); parse(value: unknown): User { return this.schema.parse(value); } }`,
		},
		{
			name: "a schema held in a private field that starts from an import",
			code: `import { schemas } from "./schemas";
class Users { readonly #schema = schemas.user; parse(value: unknown): User { return this.#schema.parse(value); } }`,
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
			name: "a member of this",
			code: `interface P { readonly id: string }
class C {
  codec = { parseUser: (v: any): P => v };
  run(value: unknown): P { return this.codec.parseUser(value); }
}`,
			errors: [error],
		},
		{
			name: "a field of this declared without an initializer",
			code: `class Users { schema: Schema; constructor() { this.schema = { parse: (v: any): User => v }; } parse(value: unknown): User { return this.schema.parse(value); } }`,
			errors: [error],
		},
		{
			name: "a field of this that is not declared in the class",
			code: "class Users extends Base { parse(value: unknown): User { return this.schema.parse(value); } }",
			errors: [error],
		},
		{
			name: "a field of this with a computed name",
			code: "class Users { parse(value: unknown): User { return this['schema'].parse(value); } }",
			errors: [error],
		},
		{
			name: "a field of this that holds a local object",
			code: `class Users { schema = { parse: (v: any): User => v }; parse(value: unknown): User { return this.schema.parse(value); } }`,
			errors: [error],
		},
		{
			name: "a field of this that holds a local object under a private name",
			code: `class Users { readonly #schema = { parse: (v: any): User => v }; parse(value: unknown): User { return this.#schema.parse(value); } }`,
			errors: [error],
		},
		{
			name: "a constructor parameter property with a local default",
			code: `const own = { parse: (v: any): User => v };
class Users { constructor(private readonly schema = own) {} parse(value: unknown): User { return this.schema.parse(value); } }`,
			errors: [error],
		},
		{
			name: "fields of this that alias each other in a loop",
			code: "class Users { a = this.b; b = this.a; parse(value: unknown): User { return this.a.parse(value); } }",
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
