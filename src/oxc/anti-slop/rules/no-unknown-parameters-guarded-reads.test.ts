import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownParameter" };

/** postgres@8955077 src/implementations/database/member.ts:125 `ClassifyMember`, with `IsPlainObject` from line 90. */
const CLASSIFY_MEMBER = `import { Query, ValueProxy } from "@antelopejs/interface-database";
import { StagedObject } from "@antelopejs/interface-database/common";
import { IsBoolean, IsDocument, IsNumber, IsObject, IsString } from "./guards";
export function IsPlainObject(value: unknown): value is Record<string, unknown> {
  return IsObject(value) && Object.getPrototypeOf(value) === Object.prototype;
}
export function ClassifyMember(value: unknown): Member {
  const document: DocumentView | undefined = IsDocument(value)
    ? {
        entries: () => Object.entries(value).map(([name, item]) => [name, ClassifyMember(item)]),
        own: (name) => (Object.hasOwn(value, name) ? ClassifyMember(value[name]) : undefined),
        ownNames: () => Object.getOwnPropertyNames(value),
      }
    : undefined;
  const of = <Kind extends Member["kind"]>(kind: Kind): MemberFacts & { kind: Kind } => ({
    kind,
    json: () => JSON.stringify(value),
    document,
    refuseInQuery: () => {
      throw new Error(\`Unsupported value of kind '\${kind}' in query\`);
    },
  });
  if (value === undefined) return of("absent");
  if (value === null) return of("null");
  if (value instanceof ValueProxy) return { ...of("proxy"), value, identity: value };
  if (value instanceof Query) return { ...of("query"), value, identity: value };
  if (value instanceof StagedObject) return { ...of("staged"), value, identity: value };
  if (value instanceof Date) return { ...of("date"), value };
  if (Array.isArray(value)) {
    const list: unknown[] = value;
    return { ...of("list"), identity: list, items: () => list.map((item) => ClassifyMember(item)), constant: () => (list.every(IsConstantJson) ? list : undefined) };
  }
  if (IsPlainObject(value) && document) return { ...of("record"), identity: value, document };
  if (IsString(value)) return { ...of("text"), value };
  if (IsNumber(value)) return { ...of("number"), value };
  if (IsBoolean(value)) return { ...of("boolean"), value };
  return of("opaque");
}`;

/** interface-database-decorators@36c993f src/model.ts:163 `validate`, the static method of the class the model factory returns. */
const VALIDATE = `import { isRecord } from "./modifiers/internal/kinds";
function isCodec(type: FieldType): type is CodecLike & FieldType { return "decode" in type; }
class Model {
  public static validate(obj: unknown, options?: ValidateInputOptions): ValidationResult {
    const fields = metadata.fields;
    const errors: FieldError[] = [];
    const partial = options?.partial === true;
    const record = isRecord(obj) ? obj : undefined;
    for (const [field, type] of Object.entries(fields)) {
      if (!isCodec(type)) continue;
      if (partial && (!record || !(field in record))) continue;
      const result = type.decode(record?.[field]);
      if (result._tag === "Left") errors.push(decodeFieldError(field, result));
    }
    return errors.length === 0 ? { ok: true } : { ok: false, errors };
  }
}`;

/** dms-database@d571521 src/service/browse.ts:276 `jsTypeOf`. */
const JS_TYPE_OF = `import { isBigInt, isBoolean, isFunction, isNumber, isString, isSymbol } from "../utils/guards";
function jsTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (value instanceof Date) return "date";
  if (Array.isArray(value)) return "array";
  if (isString(value)) return "string";
  if (isNumber(value)) return "number";
  if (isBoolean(value)) return "boolean";
  if (isBigInt(value)) return "bigint";
  if (isSymbol(value)) return "symbol";
  if (isFunction(value)) return "function";
  return "object";
}`;

/** dms-database@d571521 src/service/introspect.ts:161 `inferFieldType`, with the `inferArrayType` it hands an array to. */
const INFER_FIELD_TYPE = `import { isBoolean, isNumber, isObject, isString } from "../utils/guards";
function inferArrayType(items: unknown[]): FieldDescriptor {
  const members: FieldDescriptor[] = [];
  for (const item of items) { const type = inferFieldType(item); if (type) members.push(type); }
  return { kind: "array", element: members[0] };
}
function inferFieldType(value: unknown): FieldDescriptor | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return { kind: "date" };
  if (Array.isArray(value)) return inferArrayType(value);
  if (isObject(value)) return { kind: "object", fields: {} };
  if (isString(value)) return { kind: "string" };
  if (isNumber(value)) return { kind: "number" };
  if (isBoolean(value)) return { kind: "boolean" };
  return undefined;
}`;

/** dms-database@d571521 src/utils/query.ts:103 `cellToText`. */
const CELL_TO_TEXT = `import { isBigInt, isBoolean, isFunction, isNumber, isString, isSymbol } from "../utils/guards";
export function cellToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (isString(value)) return value;
  if (isNumber(value) || isBoolean(value)) return value.toString();
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {}
  try {
    if (isBigInt(value) || isSymbol(value) || isFunction(value)) {
      return value.toString();
    }
  } catch {}
  return "";
}`;

/** antelopejs@0e6a3db src/cli/config-layout.ts:57 `toNode`. */
const TO_NODE = `import { isBoolean, isNumber, isObject, isString } from "../utils";
export function toNode(value: unknown): SourceNode {
  if (isString(value)) {
    return literal(quote(value));
  }
  if (isNumber(value)) {
    const finite = Number.isFinite(value);
    return literal(String(value).replace("e+", "e"), finite, finite && value >= 0);
  }
  if (isBoolean(value)) {
    return literal(String(value), false, true);
  }
  if (Array.isArray(value)) {
    return { kind: "array", items: value.map((item) => toNode(item)) };
  }
  if (isObject(value)) {
    const properties = Object.entries(value).map(([key, item]) => [key, toNode(item)] as const);
    return { kind: "object", properties };
  }
  return literal(String(value));
}`;

/** dms-database@d571521 src/routes/query.ts:191 `normaliseRows`, with the `isRow` guard above it. */
const NORMALISE_ROWS = `import { isObject } from "../utils/guards";
function isRow(value: unknown): value is ExecuteResult["rows"][number] {
  return isObject(value) && !Array.isArray(value);
}
function normaliseRows(raw: unknown): ExecuteResult["rows"] {
  if (Array.isArray(raw)) {
    const entries: unknown[] = raw;
    return entries.map((entry) => (isRow(entry) ? entry : { value: entry }));
  }
  if (raw === undefined) return [];
  if (isRow(raw)) {
    return [raw];
  }
  return [{ value: raw }];
}`;

/** antelopejs@0e6a3db src/core/config/config-vars.ts:44 `scanConfigVars`, with the `visitStrings` walker it forwards the config to. */
const SCAN_CONFIG_VARS = `import { isPlainObject, isString } from "../../utils";
export function scanConfigVars(config: unknown): ConfigVarScan {
  const references = new Map<string, ConfigVarReference>();
  visitStrings(config, (value) => {
    for (const reference of matchReferences(value)) references.set(reference.token, reference);
  });
  return { references: [...references.values()], malformed: [] };
}
function visitStrings(value: unknown, visit: (value: string) => void): void {
  if (isString(value)) {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => visitStrings(item, visit));
    return;
  }
  if (isPlainObject(value)) {
    Object.values(value).forEach((item) => visitStrings(item, visit));
  }
}`;

/** antelopejs@0e6a3db src/core/config/config-vars.ts:70 `substituteConfigVars`. */
const SUBSTITUTE_CONFIG_VARS = `import { isPlainObject, isString } from "../../utils";
export function substituteConfigVars(config: unknown, lookup: ConfigVarLookup): unknown {
  if (isString(config)) return substituteString(config, lookup);
  if (Array.isArray(config)) return substituteArray(config, lookup);
  if (isPlainObject(config)) return substituteObject(config, lookup);
  return config;
}`;

const GUARDS = 'import { isObject, isString } from "./guards";\n';

tester.run("anti-slop/no-unknown-parameters at a parameter read only through type guards", noUnknownParametersRule, {
	valid: [
		{
			name: "postgres ClassifyMember: fails one that loses a ?: guard inside a closure, or refuses an unknown[] alias",
			code: CLASSIFY_MEMBER,
		},
		{
			name: "interface-database-decorators validate: fails one that skips class methods or the branches of ?:",
			code: VALIDATE,
		},
		{
			name: "dms-database jsTypeOf: fails one that also requires a narrowed read",
			code: JS_TYPE_OF,
		},
		{
			name: "dms-database inferFieldType: fails one that refuses a narrowed value passed to a function",
			code: INFER_FIELD_TYPE,
		},
		{
			name: "dms-database cellToText: fails one that refuses an || of guards, JSON.stringify, or a guard inside try",
			code: CELL_TO_TEXT,
		},
		{
			name: "antelopejs toNode: fails one that refuses String(value) where no guard holds",
			code: TO_NODE,
		},
		{
			name: "a read after an if that throws unless the guard holds: fails one that ignores exiting guards",
			code: `${GUARDS}function size(value: unknown): number { if (!isString(value)) { throw new TypeError("text"); } return value.length; }`,
		},
		{
			name: "typeof compared with a literal: fails one that only trusts guard calls",
			code: 'function size(value: unknown): number { return typeof value === "string" ? value.length : 0; }',
		},
		{
			name: "a negated guard in the test of an else: fails one that ignores the alternate",
			code: `${GUARDS}function size(value: unknown): number { if (!isString(value)) return 0; else return value.length; }`,
		},
		{
			name: "the parameter handed back to the function itself: fails one that refuses recursion",
			code: `${GUARDS}function depthOf(value: unknown, limit: number): number { if (limit > 0 && !isObject(value)) return depthOf(value, limit - 1); return isString(value) ? value.length : 0; }`,
		},
		{
			name: "a guard declared as a const arrow: fails one that only resolves function declarations",
			code: 'const isText = (value: unknown): value is string => typeof value === "string";\nfunction size(value: unknown): number { return isText(value) ? value.length : 0; }',
		},
		{
			name: "String(value) alone: fails one that requires a type test beside a total conversion",
			code: "function label(value: unknown): string { return String(value); }",
		},
		{
			name: "JSON.stringify(value) alone: fails one that trusts only String",
			code: "function encode(value: unknown): string { return JSON.stringify(value); }",
		},
		{
			name: "JSON.stringify(value, null, 2): fails one that requires the value to be the only argument",
			code: "function encode(value: unknown): string { return JSON.stringify(value, null, 2); }",
		},
		{
			name: "a promised parsed value: fails one that refuses an async parser",
			code: `${GUARDS}async function size(value: unknown): Promise<number> { return isString(value) ? value.length : 0; }`,
		},
	],
	invalid: [
		{
			name: "dms-database normaliseRows stores raw unparsed: fails one that accepts a store outside a guard",
			code: NORMALISE_ROWS,
			errors: [{ ...error, data: { parameter: "raw" } }],
		},
		{
			name: "antelopejs scanConfigVars forwards config to visitStrings, which returns void: fails one that trusts a same-file callee by its unknown parameter alone, or exempts a void walker",
			code: SCAN_CONFIG_VARS,
			errors: [
				{ ...error, data: { parameter: "config" } },
				{ ...error, data: { parameter: "value" } },
			],
		},
		{
			name: "antelopejs substituteConfigVars returns unknown: fails one that skips the return type",
			code: SUBSTITUTE_CONFIG_VARS,
			errors: [{ ...error, data: { parameter: "config" } }],
		},
		{
			name: "a cast inside a guarded branch: fails one that checks casts only where no guard holds",
			code: `${GUARDS}function load(value: unknown): Config { if (isObject(value)) return value as Config; return DEFAULTS; }`,
			errors: [error],
		},
		{
			name: "a cast where no guard holds: fails one that treats as as a type test",
			code: `${GUARDS}function load(value: unknown): Config { if (isString(value)) return fromText(value); return value as Config; }`,
			errors: [error],
		},
		{
			name: "a non-null assertion inside a guarded branch: fails one that checks only as",
			code: `${GUARDS}function load(value: unknown): Config { return isObject(value) ? fromObject(value!) : DEFAULTS; }`,
			errors: [error],
		},
		{
			name: "a narrowed value held under an object type annotation: fails one that misses a cast written as an annotation",
			code: `${GUARDS}function kindOf(value: unknown): string | undefined { if (!isObject(value)) return undefined; const holder: { kind?: string } = value; return holder.kind; }`,
			errors: [error],
		},
		{
			name: "a narrowed value held in a let: fails one that accepts any declaration",
			code: `${GUARDS}function size(value: unknown): number { if (!isString(value)) return 0; let held = value; return held.length; }`,
			errors: [error],
		},
		{
			name: "a property read after an exiting positive guard: fails one that treats any earlier guard as narrowing",
			code: `${GUARDS}function kindOf(value: unknown): string { if (isString(value)) return "text"; return value.kind; }`,
			errors: [error],
		},
		{
			name: "a pass-through outside any guard to a parameter typed any: fails one that accepts every call argument",
			code: `${GUARDS}function store(input: any): Config { return input; }\nfunction load(value: unknown): Config { if (isString(value)) return fromText(value); return store(value); }`,
			errors: [error],
		},
		{
			name: "a guard on another value: fails one that accepts a guard on any operand",
			code: `${GUARDS}function size(value: unknown, other: string | number): number { if (isString(value)) return value.length; return isString(other) ? value.size : 0; }`,
			errors: [error],
		},
		{
			name: "no declared return type: fails one that accepts a missing annotation",
			code: `${GUARDS}function kindOf(value: unknown) { return isString(value) ? "text" : "other"; }`,
			errors: [error],
		},
		{
			name: "a boolean answer: fails one that exempts a yes-or-no classifier instead of asking for a type predicate",
			code: `${GUARDS}function isText(value: unknown): boolean { return isString(value); }`,
			errors: [error],
		},
		{
			name: "a reassigned parameter: fails one that ignores write references",
			code: `${GUARDS}function size(value: unknown): number { if (isString(value)) { value = fetchAny(); return value.length; } return 0; }`,
			errors: [error],
		},
		{
			name: "a local isX with no type predicate: fails one that trusts any local function named isX",
			code: `function isText(value: string | number): boolean { return value === ""; }\nfunction size(value: unknown): number { return isText(value) ? value.length : 0; }`,
			errors: [error],
		},
		{
			name: "an imported function not named isX: fails one that trusts every import as a guard",
			code: 'import { check } from "./guards";\nfunction size(value: unknown): number { return check(value) ? value.length : 0; }',
			errors: [error],
		},
		{
			name: "a negated guard used as if positive: fails one that ignores the !",
			code: `${GUARDS}function size(value: unknown): number { if (!isString(value)) return value.length; return 0; }`,
			errors: [error],
		},
		{
			name: "a read through arguments: fails one that ignores implicit reads",
			code: `${GUARDS}function label(value: unknown): string { return isString(value) ? value : JSON.stringify(arguments[0]); }`,
			errors: [error],
		},
		{
			name: "a shadowed String: fails one that trusts any callee named String",
			code: "function label(value: unknown): string { const String = remember; return String(value); }",
			errors: [error],
		},
		{
			name: "a template literal: fails one that treats interpolation as String(value)",
			code: "function label(value: unknown): string { return `${value}`; }",
			errors: [error],
		},
		{
			name: "value.toString(): fails one that accepts a conversion read as a member",
			code: "function label(value: unknown): string { return value.toString(); }",
			errors: [error],
		},
		{
			name: "String(value as Label): fails one that checks only that String's first argument names the parameter",
			code: "function label(value: unknown): string { return String(value as Label); }",
			errors: [error],
		},
		{
			name: "JSON.stringify of a spread: fails one that accepts the parameter anywhere inside the converter's argument",
			code: "function encode(value: unknown): string { return JSON.stringify({ ...value }); }",
			errors: [error],
		},
		{
			name: "the parameter as JSON.stringify's indent: fails one that accepts it at any argument of a converter",
			code: "function encode(value: unknown): string { return JSON.stringify(PAYLOAD, null, value); }",
			errors: [error],
		},
		{
			name: "new String(value): fails one that accepts a construction as the String call",
			code: "function box(value: unknown): String { return new String(value); }",
			errors: [error],
		},
		{
			name: "JSON.parse(value): fails one that trusts every JSON method",
			code: "function decodeConfig(value: unknown): Config { return JSON.parse(value); }",
			errors: [error],
		},
		{
			name: "a comparison with null and nothing else: fails one that counts an equality as a type test",
			code: 'function label(value: unknown): string { return value === null ? "null" : "set"; }',
			errors: [error],
		},
	],
});
