import { RuleTester } from "oxlint/plugins-dev";

import { noRuntimeTypeofRule } from "./no-runtime-typeof.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "runtimeTypeof" };

tester.run("anti-slop/no-runtime-typeof, message sinks by where their root is declared", noRuntimeTypeofRule, {
	valid: [
		{
			name: "assert imported by default",
			code: "import assert from \"node:assert\";\nexport function f(value: unknown, ok: boolean): void { assert(ok, `got ${typeof value}`); }",
		},
		{
			name: "assert imported by name under another local name",
			code: "import { strict as assert } from \"node:assert\";\nexport function f(value: unknown, ok: boolean): void { assert(ok, `got ${typeof value}`); }",
		},
		{
			name: "assert imported as a namespace",
			code: "import * as assert from \"node:assert\";\nexport function f(value: unknown, ok: boolean): void { assert(ok, `got ${typeof value}`); }",
		},
		{
			name: "assert imported with import-equals require",
			code: "import assert = require(\"node:assert\");\nexport function f(value: unknown, ok: boolean): void { assert(ok, `got ${typeof value}`); }",
		},
		{
			name: "assert that the caller hands in as a parameter",
			code: "export function f(assert: Assert, value: unknown, ok: boolean): void { assert(ok, `got ${typeof value}`); }",
		},
		{
			name: "assert a global",
			code: "export function f(value: unknown, ok: boolean): void { assert(ok, `got ${typeof value}`); }",
		},
		{
			name: "log on a parameter",
			code: "export function f(ctx: Context, value: unknown): void { ctx.log(\"warn\", `got ${typeof value}`); }",
		},
		{
			name: "log on a member of a parameter",
			code: "export function f(ctx: Context, value: unknown): void { ctx.logger.log(`got ${typeof value}`); }",
		},
		{
			name: "log on a parameter under a non-null assertion",
			code: "export function f(ctx?: Context, value?: unknown): void { ctx!.log(`got ${typeof value}`); }",
		},
		{
			name: "log on a parameter under a type assertion",
			code: "export function f(ctx: unknown, value: unknown): void { (ctx as Context).log(`got ${typeof value}`); }",
		},
		{
			name: "log on a destructured parameter",
			code: "export function f({ ctx }: Options, value: unknown): void { ctx.log(`got ${typeof value}`); }",
		},
		{
			name: "log on an imported logger",
			code: "import { logger } from \"./logger\";\nexport function f(value: unknown): void { logger.log(`got ${typeof value}`); }",
		},
		{
			name: "log on a global console",
			code: "export function f(value: unknown): void { globalThis.console.log(`got ${typeof value}`); }",
		},
		{
			name: "log on a namespace import",
			code: "import * as logger from \"./logger\";\nexport function f(value: unknown): void { logger.log(`got ${typeof value}`); }",
		},
		{
			name: "log on an import-equals require",
			code: "import logger = require(\"./logger\");\nexport function f(value: unknown): void { logger.log(`got ${typeof value}`); }",
		},
		{
			name: "log on a parameter in an inner function that shadows a local object",
			code: "const ctx = { log(message: string): void { void message; } };\nexport function f(ctx: Context, value: unknown): void { ctx.log(`got ${typeof value}`); }",
		},
		{
			name: "log on a parameter under satisfies",
			code: "export function f(ctx: unknown, value: unknown): void { (ctx satisfies Context).log(`got ${typeof value}`); }",
		},
		{
			name: "log on a parameter under an angle-bracket assertion",
			code: "export function f(ctx: unknown, value: unknown): void { (<Context>ctx).log(`got ${typeof value}`); }",
		},
		{
			name: "log on a global declared and never written",
			code: "declare global { var logger: Logger; }\nexport function f(value: unknown): void { logger.log(`got ${typeof value}`); }",
		},
		{
			name: "assert a global read outside the namespace that declares a member of that name",
			code: "namespace Checks { export function assert(message: string): void { void message; } }\nexport function f(value: unknown): void { assert(`got ${typeof value}`); }",
		},
	],
	invalid: [
		{
			name: "an assert merged from another namespace block",
			code: "export namespace Kinds {\n  export function assert(message: string): void {\n    if (message !== \"kind:string\") throw new Error(\"not a string\");\n  }\n}\nexport namespace Kinds {\n  export function requireString(value: string | number): void {\n    assert(`kind:${typeof value}`);\n  }\n}",
			errors: [error],
		},
		{
			name: "an assert merged from another block of the legacy module spelling",
			code: "module Kinds { export function assert(message: string): void { void message; } }\nmodule Kinds { export function requireString(value: string | number): void { assert(`kind:${typeof value}`); } }",
			errors: [error],
		},
		{
			name: "a log method of an object merged from another namespace block",
			code: "namespace Sinks { export const recorder = { log(m: string): void { void m; } }; }\nnamespace Sinks { export function f(value: unknown): void { recorder.log(`got ${typeof value}`); } }",
			errors: [error],
		},
		{
			name: "a global log inside a namespace, which may be a member of another block",
			code: "namespace Checks { export function f(value: unknown): void { console.log(`got ${typeof value}`); } }",
			errors: [error],
		},
		{
			name: "console assigned a local object",
			code: "const recorded = { last: \"\" };\nconst original = console;\nconsole = { ...original, log(message: string): void { recorded.last = message; } };\nexport function isString(value: string | number): boolean {\n  console.log(`kind:${typeof value}`);\n  return recorded.last === \"kind:string\";\n}",
			errors: [error],
		},
		{
			name: "a global assert assigned in a function",
			code: "function install(): void { assert = (message: string): void => { void message; }; }\nexport function f(value: unknown): void { assert(`got ${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a declared global assert assigned in the file",
			code: "declare global { var assert: (message: string) => void; }\nassert = (message: string): void => { void message; };\nexport function f(value: unknown): void { assert(`got ${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a local function named assert that branches on the text",
			code: "function assert(message: string): void {\n  if (message !== \"kind:string\") throw new Error(\"not a string\");\n}\nexport function requireString(value: string | number): void {\n  assert(`kind:${typeof value}`);\n}",
			errors: [error],
		},
		{
			name: "a local arrow named assert",
			code: "const assert = (message: string): void => { if (message !== \"kind:string\") throw new Error(\"x\"); };\nexport function f(value: string | number): void { assert(`kind:${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a local let named assert",
			code: "let assert = (message: string): void => { void message; };\nexport function f(value: string | number): void { assert(`kind:${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a local const assert that shadows node:assert inside a function",
			code: "import nodeAssert from \"node:assert\";\nexport function f(value: string | number): void {\n  const assert = (message: string): void => { if (message !== \"kind:string\") throw new Error(\"x\"); };\n  assert(`kind:${typeof value}`);\n  nodeAssert(true);\n}",
			errors: [error],
		},
		{
			name: "a const assert required from a module",
			code: "const assert = require(\"node:assert\");\nexport function f(value: unknown, ok: boolean): void { assert(ok, `got ${typeof value}`); }",
			errors: [error],
		},
		{
			name: "an import-equals alias of a local assert",
			code: "namespace Local { export function assert(message: string): void { void message; } }\nimport assert = Local.assert;\nexport function f(value: string | number): void { assert(`kind:${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a parameter named assert with a local default",
			code: "function localAssert(message: string): void { if (message !== \"kind:string\") throw new Error(\"x\"); }\nexport function f(value: string | number, assert = localAssert): void { assert(`kind:${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a parameter named assert assigned a local function",
			code: "function localAssert(message: string): void { if (message !== \"kind:string\") throw new Error(\"x\"); }\nexport function f(value: string | number, assert: Assert): void { assert = localAssert; assert(`kind:${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a parameter named assert redeclared by var",
			code: "function localAssert(message: string): void { if (message !== \"kind:string\") throw new Error(\"x\"); }\nexport function f(value: string | number, assert: Assert): void { var assert = localAssert; assert(`kind:${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a local object whose log method stores its argument",
			code: "const recorder = {\n  last: \"\",\n  log(message: string): void {\n    this.last = message;\n  },\n};\nexport function isString(value: string | number): boolean {\n  recorder.log(`kind:${typeof value}`);\n  return recorder.last === \"kind:string\";\n}",
			errors: [error],
		},
		{
			name: "a let object with a log method",
			code: "let recorder = { log(message: string): void { void message; } };\nexport function f(value: unknown): void { recorder.log(`got ${typeof value}`); }",
			errors: [error],
		},
		{
			name: "an instance of a local class",
			code: "class Recorder { last = \"\"; log(message: string): void { this.last = message; } }\nconst recorder = new Recorder();\nexport function f(value: unknown): boolean { recorder.log(`got ${typeof value}`); return recorder.last === \"got string\"; }",
			errors: [error],
		},
		{
			name: "a log call on a class made in place",
			code: "class Recorder { log(message: string): void { void message; } }\nexport function f(value: unknown): void { new Recorder().log(`got ${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a log method of this",
			code: "class Node { run(value: unknown) { this.log(`got ${typeof value}`); } log(message: string): void { void message; } }",
			errors: [error],
		},
		{
			name: "a log method of a member of this",
			code: "class Node { logger = { log(message: string): void { void message; } }; run(value: unknown) { this.logger.log(`got ${typeof value}`); } }",
			errors: [error],
		},
		{
			name: "a log method of an object a local factory returns",
			code: "function makeLogger() { return { log(message: string): void { void message; } }; }\nexport function f(value: unknown): void { makeLogger().log(`got ${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a log method of a frozen local object",
			code: "const log = (message: string): void => { void message; };\nexport function f(value: unknown): void { Object.freeze({ log }).log(`got ${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a log method of a local namespace",
			code: "namespace logger { export function log(message: string): void { void message; } }\nexport function f(value: unknown): void { logger.log(`got ${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a log method of an import-equals alias of a local namespace",
			code: "namespace Local { export function log(message: string): void { void message; } }\nimport logger = Local;\nexport function f(value: unknown): void { logger.log(`got ${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a log method of a parameter with a local default",
			code: "const recorder = { log(message: string): void { void message; } };\nexport function f(value: unknown, ctx = recorder): void { ctx.log(`got ${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a log method of a destructured parameter with a local default",
			code: "const recorder = { log(message: string): void { void message; } };\nexport function f(value: unknown, { ctx = recorder }: Options): void { ctx.log(`got ${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a log method of a parameter assigned a local object",
			code: "const recorder = { log(message: string): void { void message; } };\nexport function f(value: unknown, ctx: Context): void { ctx = recorder; ctx.log(`got ${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a log method of a parameter redeclared by var",
			code: "const recorder = { log(message: string): void { void message; } };\nexport function f(value: unknown, ctx: Context): void { var ctx = recorder; ctx.log(`got ${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a log method of a local that shadows a parameter of the outer function",
			code: "export function f(ctx: Context, value: unknown): void {\n  const run = (): void => {\n    const ctx = { log(message: string): void { void message; } };\n    ctx.log(`got ${typeof value}`);\n  };\n  run();\n}",
			errors: [error],
		},
		{
			name: "a log method of a destructured local",
			code: "const holder = { ctx: { log(message: string): void { void message; } } };\nconst { ctx } = holder;\nexport function f(value: unknown): void { ctx.log(`got ${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a log method of a catch binding",
			code: "export function f(value: unknown): void { try { run(); } catch (ctx) { ctx.log(`got ${typeof value}`); } }",
			errors: [error],
		},
		{
			name: "a log method of a call result on a parameter",
			code: "export function f(ctx: Context, value: unknown): void { ctx.child().log(`got ${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a log method of a local under satisfies",
			code: "const rec = { log(m: string): void { void m; } };\nexport function f(value: unknown): void { (rec satisfies Logger).log(`got ${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a log method of a local under an angle-bracket assertion",
			code: "const rec = { log(m: string): void { void m; } };\nexport function f(value: unknown): void { (<Logger>rec).log(`got ${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a log method of a parameter assigned with a logical assignment",
			code: "const rec = { log(m: string): void { void m; } };\nexport function f(value: unknown, ctx?: Context): void { ctx ??= rec; ctx.log(`got ${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a log method of a parameter redeclared by var with no initializer",
			code: "export function f(ctx: Context, value: unknown): void { var ctx; ctx.log(`got ${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a log method of a module import assigned a local object",
			code: "import { logger } from \"./logger\";\nconst rec = { log(m: string): void { void m; } };\nlogger = rec;\nexport function f(value: unknown): void { logger.log(`got ${typeof value}`); }",
			errors: [error],
		},
		{
			name: "a wrapped parameter called as a function is not an assert call",
			code: "export function f(assert: unknown, value: unknown): void { (assert as Assert)(true, `got ${typeof value}`); }",
			errors: [error],
		},
	],
});
