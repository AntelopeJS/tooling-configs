import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownParameter" };

tester.run("anti-slop/no-unknown-parameters at a caught-value callback type", noUnknownParametersRule, {
	valid: [
		{
			name: "interface-api-util@cc740f8 src/index.ts:72 errorFunc called with the catch variable",
			code: `export function assertValidation<T, Input = unknown>(
  body: Input,
  validator: (body: Input) => T,
  errorFunc?: (err: unknown) => unknown,
  code = 400,
): T {
  try {
    return validator(body);
  } catch (e: unknown) {
    const errObj = errorFunc ? errorFunc(e) : String(e);
    throw new HTTPResult(code, errObj);
  }
}`,
		},
		{
			name: "a required callback called with an untyped catch variable",
			code: "function run(task: () => void, onError: (error: unknown) => void) { try { task(); } catch (error) { onError(error); } }",
		},
		{
			name: "an optional call",
			code: "function run(task: () => void, onError?: (error: unknown) => void) { try { task(); } catch (error) { onError?.(error); } }",
		},
		{
			name: "a short-circuit guard on the callback",
			code: "function run(task: () => void, onError?: (error: unknown) => void) { try { task(); } catch (error) { onError && onError(error); } }",
		},
		{
			name: "a call in a closure inside the catch block",
			code: "function run(task: () => void, onError: (error: unknown) => void) { try { task(); } catch (error) { queueMicrotask(() => onError(error)); } }",
		},
		{
			name: "two call sites, both with a catch variable",
			code: `function run(a: () => void, b: () => void, onError: (error: unknown) => void) {
  try { a(); } catch (first) { onError(first); }
  try { b(); } catch (second) { onError(second); }
}`,
		},
		{
			name: "a known parameter next to the unknown one is not constrained",
			code: "function run(task: () => void, onError: (error: unknown, label: string) => void) { try { task(); } catch (error) { onError(error, 'task'); } }",
		},
		{
			name: "an arrow function owner",
			code: "const run = (task: () => void, onError: (error: unknown) => void) => { try { task(); } catch (error) { onError(error); } };",
		},
		{
			name: "a method owner",
			code: "class Runner { run(task: () => void, onError: (error: unknown) => void) { try { task(); } catch (error) { onError(error); } } }",
		},
	],
	invalid: [
		{
			name: "a call site that passes a value that is not caught",
			code: "function run(onError: (error: unknown) => void, value: string) { try { work(); } catch (error) { onError(error); } onError(value); }",
			errors: [error],
		},
		{
			name: "a call site that passes a literal beside a caught one",
			code: "function run(onError: (error: unknown) => void) { try { work(); } catch (error) { onError(error); } onError(new Error('x')); }",
			errors: [error],
		},
		{
			name: "a callback that is never called",
			code: "function run(onError: (error: unknown) => void) { return 1; }",
			errors: [error],
		},
		{
			name: "a callback handed on instead of called",
			code: "function run(onError: (error: unknown) => void) { try { work(); } catch (error) { register(onError); onError(error); } }",
			errors: [error],
		},
		{
			name: "a callback stored on a field",
			code: "class Runner { handler: unknown; run(onError: (error: unknown) => void) { this.handler = onError; try { work(); } catch (error) { onError(error); } } }",
			errors: [error],
		},
		{
			name: "a value derived from the catch variable",
			code: "function run(onError: (error: unknown) => void) { try { work(); } catch (error) { onError(String(error)); } }",
			errors: [error],
		},
		{
			name: "a member of the catch variable",
			code: "function run(onError: (error: unknown) => void) { try { work(); } catch (error) { onError(error.cause); } }",
			errors: [error],
		},
		{
			name: "a catch variable that is reassigned before the call",
			code: "function run(onError: (error: unknown) => void) { try { work(); } catch (error) { error = 1; onError(error); } }",
			errors: [error],
		},
		{
			name: "a destructured catch binding is not the thrown value",
			code: "function run(onError: (error: unknown) => void) { try { work(); } catch ({ message }) { onError(message); } }",
			errors: [error],
		},
		{
			name: "a variable that merely shares the catch variable's name",
			code: "function run(onError: (error: unknown) => void) { const error: unknown = read(); try { work(); } catch (cause) { void cause; } onError(error); }",
			errors: [error],
		},
		{
			name: "a spread argument",
			code: "function run(onError: (error: unknown) => void) { try { work(); } catch (error) { onError(...[error]); } }",
			errors: [error],
		},
		{
			name: "a callback type that is not a parameter's annotation",
			code: "type Handler = (error: unknown) => void;\nfunction run(onError: Handler) { try { work(); } catch (error) { onError(error); } }\ndeclare const handler: (error: unknown) => void;",
			errors: [error, error],
		},
		{
			name: "a callback whose second unknown parameter gets a value that is not caught",
			code: "function run(onError: (error: unknown, extra: unknown) => void, extra: string) { try { work(); } catch (error) { onError(error, extra); } }",
			errors: [error, error],
		},
		{
			name: "a callback type inside a union",
			code: "function run(onError: ((error: unknown) => void) | null) { try { work(); } catch (error) { onError?.(error); } }",
			errors: [error],
		},
		{
			name: "C9 existence-test && leaking the callback on the right",
			code: "function run(onError?: (e: unknown) => void) { try { w(); } catch (e) { onError(e); } return onError && onError; }",
			errors: [error],
		},
		{
			name: "M8 callback passed on beside the caught value",
			code: "function run(onError: (e: unknown) => void) { try { w(); } catch (e) { other(e, onError); } }",
			errors: [error],
		},
	],
});
