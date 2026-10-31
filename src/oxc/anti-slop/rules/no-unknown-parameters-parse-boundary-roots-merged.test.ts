import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownParameter" };

const LOOSE = "interface P { readonly id: string }\nfunction loose(value: any): P { return value; }\n";
const OWN_PARSER = "{ parse: loose }";

tester.run("anti-slop/no-unknown-parameters at a parse boundary, an outer binding that a merged namespace member may shadow", noUnknownParametersRule, {
	valid: [
		{
			name: "an import read outside the namespace blocks that declare a member of that name",
			code: `import { codec } from "./settings";\n${LOOSE}namespace Users { export const codec = ${OWN_PARSER}; }\nexport function readUser(value: unknown): P { return codec.parse(value); }`,
		},
		{
			name: "a parameter of a function inside a namespace block",
			code: `${LOOSE}namespace Users { export function readUser(value: unknown, codec: Codec): P { return codec.parse(value); } }`,
		},
		{
			name: "a parameter of a function inside a namespace block that another block declares a member of that name",
			code: `${LOOSE}namespace Users { export const codec = ${OWN_PARSER}; }\nnamespace Users { export function readUser(value: unknown, codec: Codec): P { return codec.parse(value); } }`,
		},
	],
	invalid: [
		{
			name: "an import called bare that another block of the namespace shadows with a function",
			code: `import { parse } from "node:path";\nexport const base = parse;\n${LOOSE}namespace Users { export function parse(input: any): P { return loose(input); } }\nnamespace Users { export function readUser(value: unknown): P { return parse(value); } }`,
			errors: [error],
		},
		{
			name: "an import read by a member that another block of the namespace shadows with an object",
			code: `import { settings } from "./settings";\nexport const base = settings;\n${LOOSE}namespace Users { export const settings = ${OWN_PARSER}; }\nnamespace Users { export function readUser(value: unknown): P { return settings.parse(value); } }`,
			errors: [error],
		},
		{
			name: "a module const alias of an import that another block of the namespace shadows",
			code: `import { settings } from "./settings";\nconst codec = settings;\nexport const base = codec;\n${LOOSE}namespace Users { export const codec = ${OWN_PARSER}; }\nnamespace Users { export function readUser(value: unknown): P { return codec.parse(value); } }`,
			errors: [error],
		},
		{
			name: "an import shadowed by a block of the legacy module spelling",
			code: `import { settings } from "./settings";\nexport const base = settings;\n${LOOSE}module Users { export const settings = ${OWN_PARSER}; }\nmodule Users { export function readUser(value: unknown): P { return settings.parse(value); } }`,
			errors: [error],
		},
		{
			name: "an import read in a block nested in a namespace that declares a member of that name",
			code: `import { settings } from "./settings";\nexport const base = settings;\n${LOOSE}namespace Outer { export const settings = ${OWN_PARSER}; }\nnamespace Outer { export namespace Inner { export function readUser(value: unknown): P { return settings.parse(value); } } }`,
			errors: [error],
		},
		{
			name: "an import read inside one namespace block, which a block written later may shadow",
			code: `import { settings } from "./settings";\n${LOOSE}namespace Users { export function readUser(value: unknown): P { return settings.parse(value); } }`,
			errors: [error],
		},
	],
});
