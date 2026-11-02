import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownParameter" };

const PROXIES = `const PROXY_BRAND = Symbol.for("antelopejs.interface-proxy");
type MaybeBranded = { [PROXY_BRAND]?: ProxyBrand };
function isObjectLike(value: Parameters<typeof IsInterfaceProxy>[0]): value is object {
  return (typeof value === "object" || typeof value === "function") && !!value;
}
function readBrand(value: Parameters<typeof IsInterfaceProxy>[0]): ProxyBrand | undefined {
  if (!isObjectLike(value)) return;
  const holder: MaybeBranded = value;
  const brand = holder[PROXY_BRAND];
  if (!brand || brand.protocol !== RUNTIME_PROTOCOL_VERSION) return;
  return brand;
}`;

tester.run("anti-slop/no-unknown-parameters at a brand probe", noUnknownParametersRule, {
	valid: [
		{
			name: "interface-core@4bf5b93 src/proxies.ts:118 IsInterfaceProxy",
			code: `${PROXIES}
export function IsInterfaceProxy(value: unknown, kind?: ProxyKind): boolean {
  const brand = readBrand(value);
  return Boolean(brand && (!kind || brand.kind === kind));
}`,
		},
		{
			name: "interface-core@4bf5b93 src/proxies.ts:124 GetInterfaceProxyIdentity",
			code: `${PROXIES}
export function GetInterfaceProxyIdentity(value: unknown): string | undefined {
  return readBrand(value)?.identity;
}`,
		},
		{
			name: "a symbol-keyed read on a value an object guard narrowed",
			code: `const BRAND = Symbol("brand");
function isObjectLike(value: unknown): value is object { return value !== null; }
function brandName(value: unknown): string | undefined {
  if (!isObjectLike(value)) return undefined;
  const holder: { [BRAND]?: string } = value; return holder[BRAND];
}`,
		},
		{
			name: "a registry symbol probe returning a boolean",
			code: `const BRAND = Symbol.for("brand");
function isObjectLike(value: unknown): value is object { return value !== null; }
function hasBrand(value: unknown): boolean { return isObjectLike(value) && BRAND in value; }`,
		},
	],
	invalid: [
		{
			name: "a probe whose reader is not written in this file",
			code: `import { readBrand } from "./brand";
export function IsBranded(value: unknown): boolean { return readBrand(value) !== undefined; }`,
			errors: [error],
		},
		{
			name: "a function that only guards its input has no brand to read",
			code: `function isObjectLike(value: object): value is object { return value !== null; }
export function isObject(value: unknown): boolean { return isObjectLike(value); }`,
			errors: [error],
		},
		{
			name: "a read keyed by a string, not a symbol",
			code: `function isObjectLike(value: unknown): value is object { return value !== null; }
function readKind(value: unknown): string | undefined {
  if (!isObjectLike(value)) return undefined;
  const holder: { kind?: string } = value;
  return holder.kind;
}`,
			errors: [error],
		},
		{
			name: "a reader that also forwards the input elsewhere",
			code: `const BRAND = Symbol.for("brand");
function readBrand(value: object): string | undefined { store(value); const holder: { [BRAND]?: string } = value; return holder[BRAND]; }
export function brandOf(value: unknown): string | undefined { return readBrand(value); }`,
			errors: [error],
		},
		{
			name: "a function that probes the brand and also forwards the input",
			code: `const BRAND = Symbol.for("brand");
function readBrand(value: object): string | undefined { const holder: { [BRAND]?: string } = value; return holder[BRAND]; }
export function brandOf(value: unknown): string | undefined { store(value); return readBrand(value); }`,
			errors: [error],
		},
		{
			name: "a probe that returns an object it claims to know the shape of",
			code: `const BRAND = Symbol.for("brand");
function readBrand(value: object): Brand | undefined { const holder: { [BRAND]?: Brand } = value; return holder[BRAND]; }
export function brandOf(value: unknown): Brand | undefined { return readBrand(value); }`,
			errors: [error],
		},
		{
			name: "a probe that returns unknown",
			code: `const BRAND = Symbol.for("brand");
function readBrand(value: object): unknown { const holder: { [BRAND]?: string } = value; return holder[BRAND]; }
export function brandOf(value: unknown): unknown { return readBrand(value); }`,
			errors: [error],
		},
		{
			name: "a probe keyed by a symbol that is a parameter, not a module constant",
			code: `function readBrand(value: object, key: symbol): string | undefined { const holder: Record<symbol, string> = value; return holder[key]; }
export function brandOf(value: unknown, key: symbol): string | undefined { return readBrand(value, key); }`,
			errors: [error],
		},
		{
			name: "a probe keyed by a let binding",
			code: `let BRAND = Symbol.for("brand");
function readBrand(value: object): string | undefined { const holder: { [BRAND]?: string } = value; return holder[BRAND]; }
export function brandOf(value: unknown): string | undefined { return readBrand(value); }`,
			errors: [error],
		},
		{
			name: "a probe keyed by a symbol the file does not create",
			code: `import { BRAND } from "./brand";
function readBrand(value: object): string | undefined { const holder: { [BRAND]?: string } = value; return holder[BRAND]; }
export function brandOf(value: unknown): string | undefined { return readBrand(value); }`,
			errors: [error],
		},
		{
			name: "a probe keyed by a symbol made by a Symbol that is not the global one",
			code: `import { Symbol } from "./symbols";
const BRAND = Symbol.for("brand");
function readBrand(value: object): string | undefined { const holder: { [BRAND]?: string } = value; return holder[BRAND]; }
export function brandOf(value: unknown): string | undefined { return readBrand(value); }`,
			errors: [error],
		},
		{
			name: "a probe that reads the brand through arguments",
			code: `const BRAND = Symbol.for("brand");
function readBrand(value: object): string | undefined { const holder: { [BRAND]?: string } = value; return holder[BRAND]; }
export function brandOf(value: unknown): string | undefined { return readBrand(arguments[0]); }`,
			errors: [error],
		},
	],
});
