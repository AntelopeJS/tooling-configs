import { RuleTester } from "oxlint/plugins-dev";

import { BUILTIN_GLOBALS } from "./builtin-globals.ts";
import { noRuntimeTypeofRule } from "./no-runtime-typeof.ts";

const testers = [
	["", new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } })],
	[", with the built-in globals declared as oxlint declares them", new RuleTester({ languageOptions: { parserOptions: { lang: "ts" }, globals: BUILTIN_GLOBALS } })],
] as const;
const error = { messageId: "runtimeTypeof" };

const RECORD = "const local = (message: string): void => { if (message !== \"kind:string\") throw new Error(\"not a string\"); };\n";

const cases = {
	valid: [
		{
			name: "an imported assert read outside the namespace blocks that declare a member of that name",
			code: `import assert from "node:assert";\nnamespace Kinds { export function assert(message: string): void { void message; } }\nexport function f(value: unknown): void { assert(\`got \${typeof value}\`); }`,
		},
		{
			name: "a parameter assert inside a namespace block that another block declares a member of that name",
			code: `namespace Kinds { export function assert(message: string): void { void message; } }\nnamespace Kinds { export function f(assert: Assert, value: unknown): void { assert(\`got \${typeof value}\`); } }`,
		},
	],
	invalid: [
		{
			name: "an imported assert that another block of the namespace shadows with a function",
			code: `${RECORD}import assert from "node:assert";\nexport const check = assert;\nexport namespace Kinds { export function assert(message: string): void { local(message); } }\nexport namespace Kinds { export function requireString(value: string | number): void { assert(\`kind:\${typeof value}\`); } }`,
			errors: [error],
		},
		{
			name: "an imported logger whose log another block of the namespace shadows",
			code: `${RECORD}import { logger } from "./logger";\nexport const base = logger;\nexport namespace Kinds { export const logger = { log: local }; }\nexport namespace Kinds { export function requireString(value: string | number): void { logger.log(\`kind:\${typeof value}\`); } }`,
			errors: [error],
		},
		{
			name: "an imported assert shadowed by a block of the legacy module spelling",
			code: `${RECORD}import assert from "node:assert";\nexport const check = assert;\nmodule Kinds { export function assert(message: string): void { local(message); } }\nmodule Kinds { export function requireString(value: string | number): void { assert(\`kind:\${typeof value}\`); } }`,
			errors: [error],
		},
		{
			name: "an imported assert read in a block nested in a namespace that declares a member of that name",
			code: `${RECORD}import assert from "node:assert";\nexport const check = assert;\nnamespace Outer { export function assert(message: string): void { local(message); } }\nnamespace Outer { export namespace Inner { export function f(value: unknown): void { assert(\`got \${typeof value}\`); } } }`,
			errors: [error],
		},
		{
			name: "an imported assert read inside one namespace block, which a block written later may shadow",
			code: `import assert from "node:assert";\nnamespace Kinds { export function f(value: unknown): void { assert(\`got \${typeof value}\`); } }`,
			errors: [error],
		},
	],
};

for (const [environment, tester] of testers) tester.run(`anti-slop/no-runtime-typeof, an outer binding that a merged namespace member may shadow${environment}`, noRuntimeTypeofRule, cases);
