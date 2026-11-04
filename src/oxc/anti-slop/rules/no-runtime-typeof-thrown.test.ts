import { RuleTester } from "oxlint/plugins-dev";

import { BUILTIN_GLOBALS } from "./builtin-globals.ts";
import { noRuntimeTypeofRule } from "./no-runtime-typeof.ts";

const testers = [
	["", new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } })],
	[", with the built-in globals declared as oxlint declares them", new RuleTester({ languageOptions: { parserOptions: { lang: "ts" }, globals: BUILTIN_GLOBALS } })],
] as const;
const error = { messageId: "runtimeTypeof" };

const RECORDER = "const recorded = { last: \"\" };\nclass Check {\n  constructor(message: string) { recorded.last = message; }\n}\n";

const cases = {
	valid: [
		{
			name: "a thrown global Error",
			code: "export function f(value: unknown): never { throw new Error(`got ${typeof value}`); }",
		},
		{
			name: "a thrown global TypeError",
			code: "export function f(value: unknown): never { throw new TypeError(`got ${typeof value}`); }",
		},
		{
			name: "a thrown class imported by name",
			code: "import { ValidationError } from \"./errors\";\nexport function f(value: unknown): never { throw new ValidationError(`got ${typeof value}`); }",
		},
		{
			name: "a thrown class that is a member of an imported namespace",
			code: "import * as errors from \"./errors\";\nexport function f(value: unknown): never { throw new errors.ValidationError(`got ${typeof value}`); }",
		},
		{
			name: "a thrown class the caller hands in as a parameter",
			code: "export function f(Failure: new (message: string) => Error, value: unknown): never { throw new Failure(`got ${typeof value}`); }",
		},
	],
	invalid: [
		{
			name: "a thrown local class that stores the message",
			code: `${RECORDER}export function isString(value: string | number): boolean {\n  try { throw new Check(\`kind:\${typeof value}\`); } catch { return recorded.last === "kind:string"; }\n}`,
			errors: [error],
		},
		{
			name: "a thrown local class that extends Error",
			code: "class Failure extends Error {}\nexport function f(value: unknown): never { throw new Failure(`got ${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a thrown class expression",
			code: `${RECORDER.slice(0, RECORDER.indexOf("class"))}export function f(value: unknown): never { throw new (class { constructor(message: string) { recorded.last = message; } })(\`got \${typeof value}\`); }`,
			errors: [error],
		},
		{
			name: "a thrown class read from this",
			code: "export class Registry { Failure = class extends Error {}; f(value: unknown): never { throw new this.Failure(`got ${typeof value}`); } }",
			errors: [error],
		},
		{
			name: "a thrown class returned by a call",
			code: "declare function make(): new (message: string) => Error;\nexport function f(value: unknown): never { throw new (make())(`got ${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a thrown class assigned to the global Error",
			code: `${RECORDER}Error = Check;\nexport function f(value: unknown): never { throw new Error(\`got \${typeof value}\`); }`,
			errors: [error],
		},
		{
			name: "a thrown Error inside a namespace block, which another block may declare",
			code: "namespace Checks { export function f(value: unknown): never { throw new Error(`got ${typeof value}`); } }",
			errors: [error],
		},
		{
			name: "a thrown Error whose name a class merged from another namespace block takes",
			code: `${RECORDER.slice(0, RECORDER.indexOf("class"))}namespace K { export class Error { constructor(message: string) { recorded.last = message; } } }\nnamespace K { export function f(value: string | number): boolean { try { throw new Error(\`kind:\${typeof value}\`); } catch { return recorded.last === "kind:string"; } } }`,
			errors: [error],
		},
	],
};

for (const [environment, tester] of testers) tester.run(`anti-slop/no-runtime-typeof, the class a thrown new is read from${environment}`, noRuntimeTypeofRule, cases);
