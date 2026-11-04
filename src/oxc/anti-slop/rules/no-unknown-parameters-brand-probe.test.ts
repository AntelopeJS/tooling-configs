import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownParameter" };

const PROXIES = `const PROXY_BRAND = Symbol.for("antelopejs.interface-proxy");
type MaybeBranded = { [PROXY_BRAND]?: ProxyBrand };
function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" || typeof value === "function") && !!value;
}
function readBrand(value: MaybeBranded): ProxyBrand | undefined {
  const brand = value[PROXY_BRAND];
  if (!brand || brand.protocol !== RUNTIME_PROTOCOL_VERSION) return;
  return brand;
}`;

const PRELUDE = `const BRAND = Symbol.for("b");
function isObj(v: unknown): v is object { return v !== null; }
`;

tester.run("anti-slop/no-unknown-parameters at a brand probe", noUnknownParametersRule, {
	valid: [
		{
			name: "interface-core@4bf5b93 src/proxies.ts:118 IsInterfaceProxy, with the input spelled unknown once and guarded",
			code: `${PROXIES}
export function IsInterfaceProxy(value: unknown, kind?: ProxyKind): boolean {
  if (!isObjectLike(value)) return false;
  const brand = readBrand(value);
  return Boolean(brand && (!kind || brand.kind === kind));
}`,
		},
		{
			name: "interface-core@4bf5b93 src/proxies.ts:124 GetInterfaceProxyIdentity",
			code: `${PROXIES}
export function GetInterfaceProxyIdentity(value: unknown): string | undefined {
  if (!isObjectLike(value)) return undefined;
  return readBrand(value)?.identity;
}`,
		},
		{
			name: "two probes sharing one reader, as in interface-core",
			code: `${PROXIES}
export function IsInterfaceProxy(value: unknown, kind?: ProxyKind): boolean {
  if (!isObjectLike(value)) return false;
  const brand = readBrand(value);
  return Boolean(brand && (!kind || brand.kind === kind));
}
export function GetInterfaceProxyIdentity(value: unknown): string | undefined {
  if (!isObjectLike(value)) return undefined;
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
		{
			name: "M9 void probe stays exempt (control for void)",
			code: "const BRAND = Symbol.for(\"b\");\nfunction isObj(v: unknown): v is object { return typeof v === \"object\" && v !== null; }\nfunction f(v: unknown): void { if (!isObj(v)) return; const h: { [BRAND]?: string } = v; if (h[BRAND]) tick(); }",
		},
		{
			name: "a probe called in the file",
			code: "const BRAND = Symbol.for(\"b\");\nfunction isObj(v: unknown): v is object { return typeof v === \"object\" && v !== null; }\nfunction has(v: unknown): boolean { return isObj(v) && BRAND in v; }\nconst ok = has(1);\n",
		},
		{
			name: "a probe exported through a specifier",
			code: "const BRAND = Symbol.for(\"b\");\nfunction isObj(v: unknown): v is object { return typeof v === \"object\" && v !== null; }\nfunction has(v: unknown): boolean { return isObj(v) && BRAND in v; }\nexport { has };\n",
		},
		{
			name: "a probe over a shared reader, referenced in the file",
			code: "const BRAND = Symbol.for(\"b\");\nfunction isObj(v: unknown): v is object { return typeof v === \"object\" && v !== null; }\nfunction rd(o: object): Session | undefined { const h: { [BRAND]?: Session } = o; return h[BRAND]; }\nfunction has(v: unknown): boolean { return isObj(v) && rd(v) !== undefined; }\nexport { has };\n",
		},
		{
			name: "a literal-only return type",
			code: "const BRAND = Symbol.for(\"b\");\nfunction isObj(v: unknown): v is object { return typeof v === \"object\" && v !== null; }\nfunction has(v: unknown): 'yes' | 'no' { return isObj(v) && BRAND in v ? 'yes' : 'no'; }\n",
		},
		{
			name: "a literal boolean return type",
			code: "const BRAND = Symbol.for(\"b\");\nfunction isObj(v: unknown): v is object { return typeof v === \"object\" && v !== null; }\nfunction has(v: unknown): true | false { return isObj(v) && BRAND in v; }\n",
		},
		{
			name: "a non-null read returned",
			code: "const BRAND = Symbol.for(\"b\");\nfunction isObj(v: unknown): v is object { return typeof v === \"object\" && v !== null; }\nfunction idOf(v: unknown): string { if (!isObj(v)) return ''; const h: { [BRAND]?: string } = v; return h[BRAND]!; }\n",
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
			name: "a write of the brand",
			code: `${PRELUDE}function stamp(v: unknown): void { if (!isObj(v)) return; const h: { [BRAND]?: number } = v; h[BRAND] = 1; }`,
			errors: [error],
		},
		{
			name: "a write of the brand, string return",
			code: `${PRELUDE}function stamp(v: unknown): string { if (!isObj(v)) return ''; const h: { [BRAND]?: string } = v; h[BRAND] = 'x'; return 'ok'; }`,
			errors: [error],
		},
		{
			name: "a delete of the brand",
			code: `${PRELUDE}function strip(v: unknown): boolean { if (!isObj(v)) return false; const h: { [BRAND]?: number } = v; return delete h[BRAND]; }`,
			errors: [error],
		},
		{
			name: "a call of the brand member with an outside value",
			code: `${PRELUDE}function poke(v: unknown, secret: string): void { if (!isObj(v)) return; const h: { [BRAND]?: (s: string) => void } = v; h[BRAND]?.(secret); }`,
			errors: [error],
		},
		{
			name: "the brand member stored through an annotated alias, void return",
			code: `${PRELUDE}function remember(v: unknown): void { if (!isObj(v)) return; const h: { [BRAND]?: Session } = v; sessions.push(h[BRAND]!); }`,
			errors: [error],
		},
		{
			name: "the brand member stored through an annotated alias, boolean return",
			code: `${PRELUDE}function remember(v: unknown): boolean { if (!isObj(v)) return false; const h: { [BRAND]?: Session } = v; sessions.push(h[BRAND]!); return true; }`,
			errors: [error],
		},
		{
			name: "the brand member read into a local that is stored",
			code: `${PRELUDE}function remember(v: unknown): boolean { if (!isObj(v)) return false; const h: { [BRAND]?: Session } = v; const session = h[BRAND]; cache.set("s", session); return session !== undefined; }`,
			errors: [error],
		},
		{
			name: "the brand member returned from a reader whose result is stored",
			code: `${PRELUDE}function readBrand(v: object): Session | undefined { const h: { [BRAND]?: Session } = v; return h[BRAND]; }
function remember(v: unknown): boolean { if (!isObj(v)) return false; sessions.push(readBrand(v)!); return true; }`,
			errors: [error],
		},
		{
			name: "the brand member handed to a function declared in this file",
			code: `${PRELUDE}function keep(session: Session | undefined): void { sessions.push(session!); }
function remember(v: unknown): boolean { if (!isObj(v)) return false; const h: { [BRAND]?: Session } = v; keep(h[BRAND]); return true; }`,
			errors: [error],
		},
		{
			name: "the brand member passed to a global other than Boolean",
			code: `${PRELUDE}function label(v: unknown): boolean { if (!isObj(v)) return false; const h: { [BRAND]?: string } = v; return String(h[BRAND]) === 'x'; }`,
			errors: [error],
		},
		{
			name: "the brand member used as a key into a store",
			code: `${PRELUDE}function remember(v: unknown): boolean { if (!isObj(v)) return false; const h: { [BRAND]?: string } = v; return registry[h[BRAND]!] === undefined; }`,
			errors: [error],
		},
		{
			name: "the brand member joined into a string",
			code: `${PRELUDE}function label(v: unknown): string { if (!isObj(v)) return ''; const h: { [BRAND]?: string } = v; return 'brand:' + h[BRAND]; }`,
			errors: [error],
		},
		{
			name: "a probe that reads the brand through arguments",
			code: `const BRAND = Symbol.for("brand");
function readBrand(value: object): string | undefined { const holder: { [BRAND]?: string } = value; return holder[BRAND]; }
export function brandOf(value: unknown): string | undefined { return readBrand(arguments[0]); }`,
			errors: [error],
		},
		{
			name: "A1 primitive reader, result pushed by the probe, boolean return",
			code: "const BRAND = Symbol.for(\"b\");\nfunction isObj(v: unknown): v is object { return typeof v === \"object\" && v !== null; }\nfunction rd(o: object): string | undefined { const h: { [BRAND]?: string } = o; return h[BRAND]; }\nfunction remember(v: unknown): boolean { if (!isObj(v)) return false; names.push(rd(v)); return true; }",
			errors: [error],
		},
		{
			name: "A2 primitive reader, const local stored, void return",
			code: "const BRAND = Symbol.for(\"b\");\nfunction isObj(v: unknown): v is object { return typeof v === \"object\" && v !== null; }\nfunction rd(o: object): string | undefined { const h: { [BRAND]?: string } = o; return h[BRAND]; }\nfunction remember(v: unknown): void { if (!isObj(v)) return; const s = rd(v); cache.set('k', s); }",
			errors: [error],
		},
		{
			name: "A5 two readers: object reader under a primitive reader, result stored",
			code: "const BRAND = Symbol.for(\"b\");\nfunction isObj(v: unknown): v is object { return typeof v === \"object\" && v !== null; }\nfunction a(o: object): Session | undefined { const h: { [BRAND]?: Session } = o; return h[BRAND]; }\nfunction b(o: object): string | undefined { return a(o)?.token; }\nfunction remember(v: unknown): boolean { if (!isObj(v)) return false; tokens.push(b(v)); return true; }",
			errors: [error],
		},
		{
			name: "A7 boolean computed after storing a reader's primitive",
			code: "const BRAND = Symbol.for(\"b\");\nfunction isObj(v: unknown): v is object { return typeof v === \"object\" && v !== null; }\nfunction rd(o: object): string | undefined { const h: { [BRAND]?: string } = o; return h[BRAND]; }\nfunction has(v: unknown): boolean { if (!isObj(v)) return false; const s = rd(v); log(s); return s !== undefined; }",
			errors: [error],
		},
		{
			name: "B1 closure with primitive return reads the brand, closure stored",
			code: "const BRAND = Symbol.for(\"b\");\nfunction isObj(v: unknown): v is object { return typeof v === \"object\" && v !== null; }\nfunction remember(v: unknown): boolean { if (!isObj(v)) return false; const h: { [BRAND]?: Session } = v; thunks.push((): string => h[BRAND]!.token); return true; }",
			errors: [error],
		},
		{
			name: "B2 named const closure stored, primitive return",
			code: "const BRAND = Symbol.for(\"b\");\nfunction isObj(v: unknown): v is object { return typeof v === \"object\" && v !== null; }\nfunction remember(v: unknown): boolean { if (!isObj(v)) return false; const h: { [BRAND]?: string } = v; const read = (): string | undefined => h[BRAND]; thunks.push(read); return true; }",
			errors: [error],
		},
		{
			name: "B4 BRAND in value inside a stored closure keeps the value alive",
			code: "const BRAND = Symbol.for(\"b\");\nfunction isObj(v: unknown): v is object { return typeof v === \"object\" && v !== null; }\nfunction remember(v: unknown): boolean { if (!isObj(v)) return false; thunks.push((): boolean => BRAND in v); return true; }",
			errors: [error],
		},
		{
			name: "M1 non-computed .BRAND is a string key",
			code: "const BRAND = Symbol.for(\"b\");\nfunction isObj(v: unknown): v is object { return typeof v === \"object\" && v !== null; }\nfunction f(v: unknown): string | undefined { if (!isObj(v)) return; const h: { BRAND?: string } = v; return h.BRAND; }",
			errors: [error],
		},
		{
			name: "M2 shadowed Boolean stores the read",
			code: "const BRAND = Symbol.for(\"b\");\nfunction isObj(v: unknown): v is object { return typeof v === \"object\" && v !== null; }\nfunction f(v: unknown): boolean { if (!isObj(v)) return false; const Boolean = keep; const h: { [BRAND]?: string } = v; return Boolean(h[BRAND]); }",
			errors: [error],
		},
		{
			name: "M3 let local holds the read",
			code: "const BRAND = Symbol.for(\"b\");\nfunction isObj(v: unknown): v is object { return typeof v === \"object\" && v !== null; }\nfunction f(v: unknown): string | undefined { if (!isObj(v)) return; const h: { [BRAND]?: string } = v; let b = h[BRAND]; return b; }",
			errors: [error],
		},
		{
			name: "M4 let alias of the value",
			code: "const BRAND = Symbol.for(\"b\");\nfunction isObj(v: unknown): v is object { return typeof v === \"object\" && v !== null; }\nfunction f(v: unknown): boolean { if (!isObj(v)) return false; let h = v; return BRAND in h; }",
			errors: [error],
		},
		{
			name: "M5 a guard on another parameter is no guard of this one",
			code: "const BRAND = Symbol.for(\"b\");\nfunction isObj(v: unknown): v is object { return typeof v === \"object\" && v !== null; }\nfunction g(a: unknown, b: unknown): a is object { return true; }\nfunction f(v: unknown, x: unknown): boolean { return g(x, v) && isObj(v) && BRAND in v; }",
			errors: [error, error, error],
		},
		{
			name: "M7 owner leaks through arguments beside a real probe",
			code: "const BRAND = Symbol.for(\"b\");\nfunction isObj(v: unknown): v is object { return typeof v === \"object\" && v !== null; }\nfunction f(v: unknown): boolean { leaked.push(arguments[0]); return isObj(v) && BRAND in v; }",
			errors: [error],
		},
		{
			name: "B18 asserts-guard instead of predicate",
			code: "const BRAND = Symbol.for('b');\nfunction assertObj(v: unknown): asserts v is object {}\nfunction hasBrand(v: unknown): boolean { assertObj(v); return BRAND in v; }",
			errors: [error],
		},
		{
			name: "B19 parameter typed unknown inside a union",
			code: "const BRAND = Symbol.for(\"b\");\nfunction isObj(v: unknown): v is object { return typeof v === \"object\" && v !== null; }\nfunction hasBrand(v: unknown | string): boolean { return isObj(v) && BRAND in v; }",
			errors: [error],
		},
		{
			name: "an exported sibling returning the shared reader's object shape",
			code: "const BRAND = Symbol.for(\"b\");\nfunction isObj(v: unknown): v is object { return typeof v === \"object\" && v !== null; }\nfunction rd(o: object): Session | undefined { const h: { [BRAND]?: Session } = o; return h[BRAND]; }\nfunction has(v: unknown): boolean { return isObj(v) && rd(v) !== undefined; }\nexport function leak(o: object): Session | undefined { return rd(o); }\n",
			errors: [error],
		},
		{
			name: "an exported sibling with no return type",
			code: "const BRAND = Symbol.for(\"b\");\nfunction isObj(v: unknown): v is object { return typeof v === \"object\" && v !== null; }\nfunction rd(o: object): Session | undefined { const h: { [BRAND]?: Session } = o; return h[BRAND]; }\nfunction has(v: unknown): boolean { return isObj(v) && rd(v) !== undefined; }\nexport function leak(o: object) { return rd(o); }\n",
			errors: [error],
		},
	],
});
