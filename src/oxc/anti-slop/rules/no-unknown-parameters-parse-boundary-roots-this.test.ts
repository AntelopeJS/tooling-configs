import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownParameter" };

tester.run("anti-slop/no-unknown-parameters at a parse boundary, callee roots through this", noUnknownParametersRule, {
	valid: [
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
			name: "a schema handed in by a class with a static block and a computed field",
			code: `class Users {
  static { register(Users); }
  [key] = 1;
  constructor(private readonly schema: Schema) {}
  parse(value: unknown): User { return this.schema.parse(value); }
}`,
		},
		{
			name: "a schema handed in to a class expression",
			code: "const Users = class { constructor(private readonly schema: Schema) {} parse(value: unknown): User { return this.schema.parse(value); } };",
		},
		{
			name: "a schema handed in beside another parameter property",
			code: "class Users { constructor(private readonly name: string, private readonly schema: Schema) {} parse(value: unknown): User { return this.schema.parse(value); } }",
		},
	],
	invalid: [
		{
			name: "this read in a method of an object literal",
			code: "const holder = { schema, run(value: unknown): User { return this.schema.parse(value); } };",
			errors: [error],
		},
		{
			name: "a field of this in a class expression",
			code: `const Users = class { schema = { parse: (v: any): User => v }; parse(value: unknown): User { return this.schema.parse(value); } };`,
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
			name: "a field of this with a computed key is not matched to another computed key",
			code: `import { schemas } from "./schemas";
class Users { [key] = schemas.user; parse(value: unknown): User { return this[key].parse(value); } }`,
			errors: [error],
		},
		{
			name: "a field of this read through a variable named like a field",
			code: `import { schemas } from "./schemas";
class Users { schema = schemas.user; parse(value: unknown): User { return this[schema].parse(value); } }`,
			errors: [error],
		},
		{
			name: "a field inherited by a class that takes an unrelated parameter property",
			code: "class Users extends Base { constructor(private readonly name: string) { super(); } parse(value: unknown): User { return this.schema.parse(value); } }",
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
	],
});
