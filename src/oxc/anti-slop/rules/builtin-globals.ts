/** The ES built-in globals as oxlint declares them: each is bound to a variable with no definition, where a RuleTester run with no globals leaves the name unresolved. */
export const BUILTIN_GLOBALS = {
	Array: "readonly",
	Date: "readonly",
	Error: "readonly",
	JSON: "readonly",
	Map: "readonly",
	Math: "readonly",
	Number: "readonly",
	Object: "readonly",
	Promise: "readonly",
	Reflect: "readonly",
	Set: "readonly",
	String: "readonly",
	Symbol: "readonly",
	TypeError: "readonly",
	globalThis: "readonly",
} as const;
