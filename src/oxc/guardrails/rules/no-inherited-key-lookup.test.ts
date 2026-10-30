import { RuleTester } from "oxlint/plugins-dev";

import { noInheritedKeyLookupRule } from "./no-inherited-key-lookup.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});
const lookup = { messageId: "lookup" };
const inOperator = { messageId: "inOperator" };

tester.run("antelopejs/no-inherited-key-lookup", noInheritedKeyLookupRule, {
  valid: [
    {
      name: "a Map answers only the keys it was given",
      code: "const HANDLERS = new Map<string, Handler>([['a', run]]); function f(name: string) { return HANDLERS.get(name); }",
    },
    {
      name: "a literal key",
      code: "const T: Record<string, number> = { a: 1 }; const a = T['a'] + T[`a`] + T.a;",
    },
    {
      name: "mollie@02d8aa5:src/test/support/target.ts:32, a key held in a string constant",
      code: "const LIVE_KEY_VARIABLE = 'MOLLIE_API_KEY'; function select(environment: Record<string, string | undefined>) { return environment[LIVE_KEY_VARIABLE]; }",
    },
    {
      name: "postgres@302e570:src/implementations/database/value.ts:93, a typeof key",
      code: "const PRIMITIVE_TYPES: Record<string, SqlType> = { string: 'text' }; function typeOf(value: unknown) { return PRIMITIVE_TYPES[typeof value]; }",
    },
    {
      name: "cloud@f784b41e:src/secrets/transit.ts:230, keys iterated from an array of string literals",
      code: "function isEnvelope(value: object) { const fields = value as Record<string, unknown>; return ['wrappedKey', 'iv'].every((key) => typeof fields[key] === 'string'); }",
    },
    {
      name: "dms-frontend@49bfafa:templates/vue/frontend-runtime/components.ts:171, for...of over string literals",
      code: "function names(value: object) { const definition = value as Record<string, unknown>; for (const key of ['component', 'componentName']) use(definition[key]); }",
    },
    {
      name: "dms-frontend@49bfafa:templates/vue/frontend-runtime/fetch.ts:98, keys through a filter and sort chain",
      code: "function stable(value: object) { const record = value as Record<string, unknown>; return Object.keys(record).filter((name) => record[name] !== undefined).sort().map((name) => record[name]); }",
    },
    {
      name: "keys from Object.entries of the same table, and a chained key list in a variable",
      code: "const T: Record<string, number> = { a: 1 }; for (const [k] of Object.entries(T)) use(T[k]); Object.entries(T).map(([k]) => T[k]); const names = Object.keys(T).filter(keep); for (const n of names) use(T[n]);",
    },
    {
      name: "cloud@f784b41e:src/infra/prometheus/minute-volumes.ts:266, a key from a same-file constant object",
      code: "const WORKLOAD_LABELS = { tenantId: 'cloud.tenant' } as const; function claim(identity: Record<string, string> | undefined) { return identity?.[WORKLOAD_LABELS.tenantId]; }",
    },
    {
      name: "a {}.hasOwnProperty.call guard",
      code: "const T: Record<string, number> = { a: 1 }; function f(key: string) { return {}.hasOwnProperty.call(T, key) ? T[key] : undefined; }",
    },
    {
      name: "a write is not a lookup",
      code: "const out: Record<string, number> = {}; function f(name: string) { out[name] = 1; delete out[name]; }",
    },
    {
      name: "Object.hasOwn guards the read",
      code: "const T: Record<string, number> = { a: 1 }; function f(key: string) { return Object.hasOwn(T, key) ? T[key] : undefined; }",
    },
    {
      name: "hasOwnProperty.call guards the read",
      code: "const T: Record<string, number> = { a: 1 }; function f(key: string) { if (!Object.prototype.hasOwnProperty.call(T, key)) return; return T[key]; }",
    },
    {
      name: "a null-prototype table from Object.create(null)",
      code: "const T: Record<string, number> = Object.create(null); function f(key: string) { return T[key]; }",
    },
    {
      name: "a null-prototype object literal",
      code: "const T: Record<string, number> = { __proto__: null, a: 1 }; function f(key: string) { return T[key]; }",
    },
    {
      name: "keys from Object.keys and for-in are own keys",
      code: "const T: Record<string, number> = { a: 1 }; for (const k of Object.keys(T)) use(T[k]); for (const k in T) use(T[k]); Object.keys(T).map((k) => T[k]);",
    },
    {
      name: "tooling-configs src/guardrails/ci-workflow.ts:205, keys listed into a variable first",
      code: "function grants(expected: Record<string, string>) { const names = Object.keys(expected); return names.every((name) => read(name) === expected[name]); }",
    },
    {
      name: "a table keyed by a closed union",
      code: "type Status = 'open' | 'closed'; const LABELS: Record<Status, string> = { open: 'Open', closed: 'Closed' }; function f(s: Status) { return LABELS[s]; }",
    },
    {
      name: "an untyped literal table read with a key typed by the table",
      code: "const T = { a: 1 } as const; function f(k: keyof typeof T) { return T[k]; }",
    },
    {
      name: "an array read by index",
      code: "const xs: string[] = []; function f(i: number) { return xs[i]; }",
    },
    {
      name: "a dictionary declared elsewhere is not resolved",
      code: "import { TABLE } from './table'; function f(key: string) { return TABLE[key]; }",
    },
    {
      name: "a literal key tested with in",
      code: "const T: Record<string, number> = { a: 1 }; const has = 'a' in T;",
    },
    {
      name: "a shadowing Map binding",
      code: "const T: Record<string, number> = { a: 1 }; function f(key: string) { const T = new Map<string, number>(); return T.get(key) ?? T.size; }",
    },
  ],
  invalid: [
    {
      name: "rethinkdb@ea47b29:src/implementations/database/expression.ts:193",
      code: `
const FUNC_STAGE_MAP: Record<string, FuncStageHandler> = {
  obj_has: (expr, stage) => expr,
};
function decodeExpression(stage: QueryStage) {
  const funcHandler = FUNC_STAGE_MAP[stage.stage];
  if (funcHandler) return funcHandler(stage);
}`,
      errors: [lookup],
    },
    {
      name: "mongodb@41c1535:src/implementations/database/query.ts:46, two tables behind a conditional",
      code: `
const LIFECYCLE_HANDLERS: Record<string, LifecycleHandler> = {
  listInstances: (schemaId) => ListInstances(schemaId),
};
const EXTERNAL_LIFECYCLE_HANDLERS: typeof LIFECYCLE_HANDLERS = {
  listInstances: () => Promise.resolve([]),
};
function tryHandleLifecycle(stages: QueryStage[]) {
  const handler = (
    IsExternal() ? EXTERNAL_LIFECYCLE_HANDLERS : LIFECYCLE_HANDLERS
  )[stages[1].stage];
  return handler;
}`,
      errors: [lookup],
    },
    {
      name: "checkout-com@47a00cb:src/implementations/payment/lookup.ts:10 (checkout-com#6)",
      code: `
export function LookUp<Value>(
  table: Readonly<Record<string, Value>>,
  key: string,
): Value | undefined {
  return table[key];
}`,
      errors: [lookup],
    },
    {
      name: "dms-database@88437a6:src/utils/query.ts:75 (dms-database#65, mode hasOwnProperty)",
      code: `
const FILTER_PREDICATES: Record<
  string,
  (cell: string, value: string) => boolean
> = {
  is: (cell, value) => cell === value,
};
export function applyFilterToList<T>(rows: T[], parsed: { mode: string }) {
  const predicate = FILTER_PREDICATES[parsed.mode];
  if (!predicate) return rows;
  return rows;
}`,
      errors: [lookup],
    },
    {
      name: "dms-ai@fec9b40:sidecar/src/agent/tool-summary.ts:55 (dms-ai#101, a tool named constructor)",
      code: `
const SUMMARY_BUILDERS: Record<string, SummaryBuilder> = {
  read_file: (args) => String(args.path),
};
const FALLBACK_BUILDER: SummaryBuilder = () => "";
function buildDetail(toolName: string, args: ToolArgs): string {
  const builder = SUMMARY_BUILDERS[toolName] ?? FALLBACK_BUILDER;
  return builder(args);
}`,
      errors: [lookup],
    },
    {
      name: "dms-automation@e964756:packages/dms-automation/src/runtime/trace.ts:372 (dms-automation#86, node id constructor)",
      code: `
export function stepDurations(
  steps: readonly TraceStep[],
): Record<string, number | null> {
  const durations: Record<string, number | null> = {};
  for (const step of steps) {
    const before = durations[step.nodeId];
    durations[step.nodeId] =
      step.durationMs === null ? (before ?? null) : (before ?? 0) + step.durationMs;
  }
  return durations;
}`,
      errors: [lookup],
    },
    {
      name: "antelope-web@7465b87:layers/docs/server/dev/local-docs-asset.ts:29 (antelope-web#46)",
      code: `
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png" };
function contentType(relative: string) {
  const type = IMAGE_TYPES[extname(relative).toLowerCase()];
  return type;
}`,
      errors: [lookup],
    },
    {
      name: "antelope-web@7465b87:sites/dms/app/components/block-playground/BlockPlaygroundFrame.vue:91 (antelope-web#46)",
      code: `
const handlers: Record<string, (data: Payload) => void> = {
  ready: () => undefined,
};
function onMessage(data: Payload) {
  handlers[String(data.type)]?.(data);
}`,
      errors: [lookup],
    },
    {
      name: "a stage name tested with in against a stage table (rethinkdb@4580c02)",
      code: `
const STREAM_STAGE_MAP = {
  changes: handleChanges,
} satisfies Record<string, StreamStageHandler>;
function decode(name: string) {
  if (name in STREAM_STAGE_MAP) return true;
  return false;
}`,
      errors: [inOperator],
    },
    {
      name: "mollie@60405ad:src/mollie/amounts.ts:42, an untyped table read with an asserted key",
      code: `
const DECIMALS_BY_CURRENCY = { EUR: 2, JPY: 0 };
function decimalsOf(currency: string): number {
  return DECIMALS_BY_CURRENCY[currency as keyof typeof DECIMALS_BY_CURRENCY];
}`,
      errors: [lookup],
    },
    {
      name: "a compound assignment reads first",
      code: "const counts: Record<string, number> = {}; function count(word: string) { counts[word] += 1; counts[word]++; }",
      errors: [lookup, lookup],
    },
    {
      name: "an index signature behind a local alias and interface",
      code: `
type Lookup = { [key: string]: Handler };
interface Registry { readonly [name: string]: Handler }
const A: Lookup = {};
const B: Registry = {};
function f(name: string) { return A[name] ?? B[name]; }`,
      errors: [lookup, lookup],
    },
    {
      name: "dms-automation@85c0a32:packages/dms-automation/src/runtime/executor.ts:420, a table asserted to Record",
      code: "const LABELS = { open: 'Open' } as Record<string, string>; function label(s: string) { return LABELS[s]; }",
      errors: [lookup],
    },
    {
      name: "dms-builder engine/project-config.ts:271, a Record parameter that may be undefined",
      code: "function f(m: Record<string, number> | undefined, n: Record<string, number> | null, k: string) { return m?.[k] ?? n?.[k]; }",
      errors: [lookup, lookup],
    },
    {
      name: "interface-database-decorators@fc2cead:src/common.ts:57-60, a class-field table read through this",
      code: `
class SchemaModel {
  public readonly indexes: Record<string, Array<string>> = {};
  addIndex(key: string, group: string) {
    if (!(group in this.indexes)) {
      this.indexes[group] = [];
    }
    this.indexes[group].push(key);
  }
}`,
      errors: [inOperator, lookup],
    },
    {
      name: "interface-api@4927ada:src/controller.ts:187-189, a class-field table keyed by PropertyKey",
      code: `
class ControllerProto {
  private computed_props: Record<PropertyKey, ComputedParameter> = {};
  getComputedParameter(key: PropertyKey) {
    if (!(key in this.computed_props)) {
      this.computed_props[key] = { modifiers: [] };
    }
    return this.computed_props[key];
  }
}`,
      errors: [inOperator, lookup],
    },
    {
      name: "tooling-configs@4334123:src/guardrails/config-scopes.ts:86, keys from another table's entries",
      code: "function covered(limits: Record<string, number>, counts: Record<string, number>) { for (const [key] of Object.entries(counts)) use(limits[key]); }",
      errors: [lookup],
    },
    {
      name: "an imported constant key is not resolved (cloud minute-volumes.ts imports WORKLOAD_LABELS)",
      code: "import { WORKLOAD_LABELS } from './metering'; function claim(identity: Record<string, string> | undefined) { return identity?.[WORKLOAD_LABELS.tenantId]; }",
      errors: [lookup],
    },
    {
      name: "a guard on a different key does not cover the read",
      code: "const T: Record<string, number> = { a: 1 }; function f(key: string, other: string) { return Object.hasOwn(T, other) ? T[key] : undefined; }",
      errors: [lookup],
    },
  ],
});
