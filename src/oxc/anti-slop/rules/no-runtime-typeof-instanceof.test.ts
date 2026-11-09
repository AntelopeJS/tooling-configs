import { RuleTester } from "oxlint/plugins-dev";

import { noRuntimeTypeofRule } from "./no-runtime-typeof.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const functionError = { messageId: "instanceofCheck", data: { name: "Function" } };
const objectError = { messageId: "instanceofCheck", data: { name: "Object" } };
const allowInTypeGuards = [{ allowInTypeGuards: true }];

tester.run("anti-slop/no-runtime-typeof, instanceof a built-in that stands in for typeof", noRuntimeTypeofRule, {
	valid: [
		"if (error instanceof ValidationError) report(error);",
		"const failed = reason instanceof Error;",
		"const boxed = value instanceof String;",
		"const list = value instanceof Array;",
		{
			name: "a type guard that tests instanceof Function",
			code: "const isCallable = (value: unknown): value is Function => value instanceof Function;",
			options: allowInTypeGuards,
		},
	],
	invalid: [
		{
			name: "dms#564 .agents/probes/interface-components.cjs:83 a member narrowed with instanceof Function",
			filename: "interface-components.cjs",
			code: "function ownMethod(target, key) { const member = target[key]; return member instanceof Function ? member : undefined; }",
			errors: [functionError],
		},
		{ code: "if (!(handler instanceof Function)) throw new Error();", errors: [functionError] },
		{ code: "const record = value instanceof Object;", errors: [objectError] },
		{ code: "const callable = value?.call instanceof Function;", errors: [functionError] },
		{
			name: "a type guard only exempts with allowInTypeGuards",
			code: "const isCallable = (value: unknown): value is Function => value instanceof Function;",
			errors: [functionError],
		},
	],
});
