import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownParameter" };

const ZOD = 'import { z } from "zod";\nconst userSchema = z.object({ id: z.string() });\n';

tester.run("anti-slop/no-unknown-parameters at a parse boundary, where the decoder comes from", noUnknownParametersRule, {
	valid: [
		{
			name: "a schema built in this file from a zod import",
			code: `${ZOD}function parseUser(value: unknown): User { return userSchema.parse(value); }`,
		},
		{
			name: "a schema built by a chain of zod calls",
			code: 'import { z } from "zod";\nconst userSchema = z.object({ id: z.string(), name: z.string().min(1) }).strict();\nfunction parseUser(value: unknown): User { return userSchema.parse(value); }',
		},
		{
			name: "a const alias of a schema",
			code: `${ZOD}const strictUser = userSchema;\nfunction parseUser(value: unknown): User { return strictUser.parse(value); }`,
		},
		{
			name: "a schema of a zod subpath",
			code: 'import * as z from "zod/v4";\nconst userSchema = z.object({});\nfunction parseUser(value: unknown): User { return userSchema.parse(value); }',
		},
		{
			name: "a decoder imported by name from valibot",
			code: 'import { object, parse } from "valibot";\nconst userSchema = object({});\nfunction parseUser(value: unknown): User { return parse(userSchema, value); }',
		},
		{
			name: "a decoder read through a valibot namespace import",
			code: 'import * as v from "valibot";\nconst userSchema = v.object({});\nfunction parseUser(value: unknown): User { return v.parse(userSchema, value); }',
		},
		{
			name: "a typebox decode",
			code: 'import { Value } from "@sinclair/typebox/value";\nfunction parseUser(value: unknown): User { return Value.Decode(UserType, value); }',
		},
		{
			name: "a schema handed to another call keeps its decoder",
			code: `${ZOD}export const jsonSchema = describe(userSchema);\nfunction parseUser(value: unknown): User { return userSchema.parse(value); }`,
		},
		{
			name: "arguments read in a sibling function does not refuse this one",
			code: `${ZOD}function parseUser(value: unknown): User { return userSchema.parse(value); }\nfunction forward() { return sink(arguments[0]); }`,
		},
	],
	invalid: [
		{
			name: "a decoder read from a name no import binds",
			code: "function parseUser(value: unknown): User { return userSchema.parse(value); }",
			errors: [error],
		},
		{
			name: "#115 item 1: a member of an import this file rewrites",
			code: 'import { shared } from "./shared";\nconst own = (input: User): User => input;\nshared.parse = own;\nexport function parseUser(value: unknown): User { return shared.parse(value); }',
			errors: [error],
		},
		{
			name: "#115 item 1: the decoder of a zod schema this file rewrites",
			code: `${ZOD}userSchema.parse = (input: User): User => input;\nexport function parseUser(value: unknown): User { return userSchema.parse(value); }`,
			errors: [error],
		},
		{
			name: "#115 item 1: a zod schema this file rewrites through Object.assign",
			code: `${ZOD}Object.assign(userSchema, { parse: loose });\nexport function parseUser(value: unknown): User { return userSchema.parse(value); }`,
			errors: [error],
		},
		{
			name: "#115 item 1: a zod import this file rewrites",
			code: `${ZOD}z.object = loose;\nexport function parseUser(value: unknown): User { return userSchema.parse(value); }`,
			errors: [error],
		},
		{
			name: "#115 item 1: a global this file writes",
			code: "globalThis.parseIt = (input: User): User => input;\nexport function parseUser(value: unknown): User { return parseIt(value); }",
			errors: [error],
		},
		{
			name: "a schema reassigned after its zod initializer",
			code: `import { z } from "zod";\nlet userSchema = z.object({});\nuserSchema = loose;\nexport function parseUser(value: unknown): User { return userSchema.parse(value); }`,
			errors: [error],
		},
		{
			name: "#115 item 1 and 2: a codec this file sets on this in another method",
			code: "export class Users { codec = strict; loosen(): void { this.codec = own; } parse(value: unknown): User { return this.codec.parse(value); } }",
			errors: [error],
		},
		{
			name: "#115 item 2: a codec a factory in this file is handed",
			code: "type Codec = { parse(input: unknown): User };\nconst reader = (codec: Codec) => (value: unknown): User => codec.parse(value);\nexport const readUser = reader({ parse: (input) => input as User });",
			errors: [error, error],
		},
		{
			name: "#115 item 2: a schema a subclass in this file overrides",
			code: `${ZOD}class Base { schema = userSchema; parse(value: unknown): User { return this.schema.parse(value); } }\nexport class Loose extends Base { override schema = loose; }`,
			errors: [error],
		},
		{
			name: "#115 item 4: an import renamed to a decoder name",
			code: 'import { identity as parseUser } from "./util";\nexport function parseAny(value: unknown): User { return parseUser(value); }',
			errors: [error],
		},
		{
			name: "#115 item 4: a schema imported from another file of the repository",
			code: 'import { userSchema } from "./schemas";\nexport function parseUser(value: unknown): User { return userSchema.parse(value); }',
			errors: [error],
		},
		{
			name: "#115 item 4: two decoder-named functions in two files",
			code: 'import { parseB } from "./b";\nexport function parseA(value: unknown): Parsed { return parseB(value); }',
			errors: [error],
		},
		{
			name: "dms@1b1a4cf src/routes/store.ts:26 assertValidation takes any validator",
			code: `${ZOD}import { assertValidation } from "@antelopejs/interface-api-util";\nfunction parseStoreOperation(body: unknown): StoreOperationBody { return assertValidation(body, (value) => userSchema.parse(value)); }`,
			errors: [error],
		},
		{
			name: "two decoder-named functions that call each other decode nothing",
			code: "export function parseA(value: unknown): Parsed { return parseB(value); }\nexport function parseB(value: unknown): Parsed { return parseA(value); }",
			errors: [error, error],
		},
		{
			name: "a decoder-named callee passed in as a parameter",
			code: "function read(parse: Decoder, value: unknown): Parsed { return parse(value); }",
			errors: [error],
		},
		{
			name: "methods of one class that call each other through this",
			code: "class Parsers {\n  parseA(value: unknown): Parsed { return this.parseB(value); }\n  parseB(value: unknown): Parsed { return this.parseA(value); }\n}",
			errors: [error, error],
		},
		{
			name: "methods of an object literal declared in the same file",
			code: "const parsers = {\n  parseA(value: unknown): Parsed { return parsers.parseB(value); },\n  parseB(value: unknown): Parsed { return parsers.parseA(value); },\n};",
			errors: [error, error],
		},
		{
			name: "a method reached through super",
			code: "class Base { parseB(value: unknown): Parsed { return value as Parsed; } }\nclass Child extends Base { parseA(value: unknown): Parsed { return super.parseB(value); } }",
			errors: [error, error],
		},
		{
			name: "the raw value read beside the decode through arguments",
			code: `${ZOD}function parseWithArguments(value: unknown): Parsed { console.log(arguments[0]); return userSchema.parse(value); }`,
			errors: [error],
		},
		{
			name: "arguments read inside a nested arrow, which shares them",
			code: `${ZOD}function parseWithArguments(value: unknown): Parsed { later(() => arguments[0]); return userSchema.parse(value); }`,
			errors: [error],
		},
		{
			name: "a direct eval can read the parameter by name",
			code: `${ZOD}function parseWithEval(value: unknown): Parsed { sink(eval("value")); return userSchema.parse(value); }`,
			errors: [error],
		},
	],
});
