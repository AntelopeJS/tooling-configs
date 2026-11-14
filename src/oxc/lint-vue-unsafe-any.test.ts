import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parityLines,
  tsconfig,
  unsafeFindings as findings,
} from "./helpers/unsafe-any-parity.ts";

const component = `<template><p>{{ label }}</p></template>

<script setup lang="ts">
declare const raw: string;
function show(text: string): string { return text; }
function parse(text: string): number { return JSON.parse(text); }
const label: string = JSON.parse(raw);
show(JSON.parse(raw));
const kept: unknown = JSON.parse(raw);
show(String(kept));
show(String(parse(raw)));
</script>
`;

test("an any assigned, passed or returned in a .vue script setup is reported once, and an unknown binding is not (fails if oxlint skips .vue scripts or the rule also reports .ts files)", () => {
  assert.deepEqual(
    findings({
      "tsconfig.json": tsconfig,
      "app/Label.vue": component,
      "src/parse.ts": 'export const parsed: string = JSON.parse("1");\n',
    }),
    [
      "app/Label.vue:6 antelopejs(no-unsafe-any-in-vue)",
      "app/Label.vue:7 antelopejs(no-unsafe-any-in-vue)",
      "app/Label.vue:8 antelopejs(no-unsafe-any-in-vue)",
      "src/parse.ts:1 typescript(no-unsafe-assignment)",
    ],
  );
});

test("a component with generic type parameters is skipped (fails if the rule reads the error types only Vue's compiler resolves)", () => {
  assert.deepEqual(
    findings({
      "tsconfig.json": tsconfig,
      "app/List.vue":
        '<script setup lang="ts" generic="T">\ndefineProps<{ item: T }>();\nconst copy: string = JSON.parse("1");\n</script>\n',
    }),
    [],
  );
});

test("rest, unknown and optional-callback targets, async unknown returns and another component's types are left alone, and an any past a rest position is reported (fails if parameters are read by index, a Promise or union target is not unwrapped, or an error type counts as any)", () => {
  assert.deepEqual(
    findings({
      "tsconfig.json": tsconfig,
      "app/List.vue":
        '<script lang="ts">\nexport interface Item { name: string }\n</script>\n',
      "app/Page.vue": `<script setup lang="ts">
import type { Item } from "./List.vue";
declare const raw: string;
declare function log(...data: unknown[]): void;
declare function tag(label: string, ...parts: string[]): string;
declare function on(handler?: () => unknown): void;
log(JSON.parse(raw));
tag("a", "b", JSON.parse(raw));
on(() => JSON.parse(raw));
async function load(): Promise<unknown> { return JSON.parse(raw); }
function label(item: Item): string { return item.name; }
void load; void label;
</script>
`,
    }),
    ["app/Page.vue:8 antelopejs(no-unsafe-any-in-vue)"],
  );
});

test("an any in an object literal property, a default value, a spread, a destructured binding or an any[] into a typed array is reported (fails if the rule checks only declarations, arguments and returns)", () => {
  assert.deepEqual(
    findings({
      "tsconfig.json": tsconfig,
      "app/User.vue": `<script setup lang="ts">
interface User { name: string }
declare const raw: string;
declare const rows: any[];
declare const pair: { a: any; b: string };
declare function names(...list: string[]): void;
const user: User = { name: JSON.parse(raw) };
function greet(name: string = JSON.parse(raw)): string { return name; }
names(...rows);
const { a, b } = pair;
const typed: string[] = rows;
const [...rest] = rows;
const copy = [...rows];
void [user, greet, a, b, typed, rest, copy];
</script>
`,
    }),
    [
      "app/User.vue:10 antelopejs(no-unsafe-any-in-vue)",
      "app/User.vue:11 antelopejs(no-unsafe-any-in-vue)",
      "app/User.vue:12 antelopejs(no-unsafe-any-in-vue)",
      "app/User.vue:13 antelopejs(no-unsafe-any-in-vue)",
      "app/User.vue:7 antelopejs(no-unsafe-any-in-vue)",
      "app/User.vue:8 antelopejs(no-unsafe-any-in-vue)",
      "app/User.vue:9 antelopejs(no-unsafe-any-in-vue)",
    ],
  );
});

test("unknown properties and defaults, destructuring assignment targets, typed bindings and an any[] into a readonly array are left alone (fails if the names in ({ a } = value) are read as values, an unknown slot counts as typed, or Array and ReadonlyArray are compared)", () => {
  assert.deepEqual(
    findings({
      "tsconfig.json": tsconfig,
      "app/Form.vue": `<script setup lang="ts">
declare const raw: string;
declare const rows: any[];
declare const pair: { a: string; b: number };
let target: any;
const box: { value: unknown } = { value: JSON.parse(raw) };
function keep(value: unknown = JSON.parse(raw)): unknown { return value; }
({ target } = { target: "a" });
const { a, b } = pair;
const view: readonly string[] = rows;
void [box, keep, target, a, b, view];
</script>
`,
    }),
    [],
  );
});

test("a shorthand property, a destructuring default and an any[] passed or returned as a typed array are reported, beside a recursive array alias (fails if shorthand values, binding-element defaults, or arrays outside declarations are not checked, or element types are compared without a depth bound)", () => {
  assert.deepEqual(
    findings({
      "tsconfig.json": tsconfig,
      "app/Rows.vue": `<script setup lang="ts">
declare const parsed: any;
declare const rows: any[];
declare const pair: { a?: string };
declare function take(list: string[]): void;
const box: { parsed: string } = { parsed };
const { a = parsed } = pair;
take(rows);
function list(): string[] { return rows; }
type Nest = Nest[];
declare const nest: Nest;
const same: Nest = nest;
void [box, a, list, same];
</script>
`,
    }),
    [
      "app/Rows.vue:6 antelopejs(no-unsafe-any-in-vue)",
      "app/Rows.vue:7 antelopejs(no-unsafe-any-in-vue)",
      "app/Rows.vue:8 antelopejs(no-unsafe-any-in-vue)",
      "app/Rows.vue:9 antelopejs(no-unsafe-any-in-vue)",
    ],
  );
});

test("a binding an index signature or a Set types any, an object or tuple rest, a spread into an any callee or constructor and a tuple into a tuple of another shape are left alone (fails if a binding is judged by its own type rather than its source's declared slot, a rest is checked, the callee is not checked, or tuples are compared by element type alone)", () => {
  assert.deepEqual(
    findings({
      "tsconfig.json": tsconfig,
      "app/Loose.vue": `<script setup lang="ts">
declare const rows: any[];
interface Payload { id: string; [key: string]: any }
declare const record: Payload;
declare const set: Set<any>;
declare const call: any;
declare const pairOf: [any, string];
declare const labelled: [string, any];
const { anything } = record;
const [member] = set;
call(...rows);
const frozen: readonly [string, string] = pairOf;
const longer: [string, string, number?] = pairOf;
const { ...others } = { a: rows[0] as unknown, b: call as unknown };
const [head, ...tail] = labelled;
new call(...rows);
void [anything, member, frozen, longer, others, head, tail];
</script>
`,
    }),
    [],
  );
});

test("a one-line script setup whose text repeats in an earlier block is reported at its own line only (fails if the script is located by the first occurrence of its text in the component)", () => {
  assert.deepEqual(
    findings({
      "tsconfig.json": tsconfig,
      "app/Echo.vue": `<script lang="ts">
export declare const raw: string;
export function show(text: string): string { return text; }
export const sample = "show(JSON.parse(raw));";
</script>

<script setup lang="ts">show(JSON.parse(raw));</script>
`,
    }),
    ["app/Echo.vue:7 antelopejs(no-unsafe-any-in-vue)"],
  );
});

const parity = `declare const parsedAny: any;
declare const rows: any[];
declare const labelledAnyTuple: [first: string, second: any];
declare function gen<T>(value: T): T;
let x: string;
let u: unknown;
let deep: string;
let q: string;
({ x } = { x: parsedAny });
gen({ a: parsedAny });
const h: { k: any } = { k: parsedAny };
({ u } = { u: parsedAny });
({ a: { deep } } = { a: { deep: parsedAny } });
[q] = rows;
({ x = parsedAny } = {} as { x?: string });
function keep(value: any = parsedAny): void { void value; }
const n: [string, string] = labelledAnyTuple;
function loose(): any { return parsedAny; }
const same: any[] = rows;
declare const pair: { a: any };
declare const name: string;
[
  x,
  q,
] = rows;
({ ["a"]: x } = pair);
({ [name]: x } = pair);
const { a = parsedAny } = {} as { a?: unknown };
void [x, u, deep, q, h, keep, n, loose, same, a];
`;

test("a destructuring assignment, an object literal into a generic or any slot and an any default are reported, and a labelled tuple into an unlabelled one is not, on the same lines tsgolint reports in a .ts file (fails if destructuring assignments are skipped, an any slot counts as safe for an assignment, or tuples are compared by element type rather than generic target, an any[] pattern is reported per element, a computed literal key is skipped, or a declaration default is compared with its unknown slot rather than its binding's type)", () => {
  const expected = [9, 9, 10, 11, 12, 13, 13, 14, 15, 16, 22, 26, 28];
  assert.deepEqual(parityLines("Parity", parity), {
    ts: expected,
    vue: expected,
  });
});

const aliased = `type AA = any[];
type G<T> = T[];
type Pair = [any, string];
declare const aa: AA;
declare const ga: G<any>;
declare const pair: Pair;
declare const rows: any[];
declare function take(list: string[]): void;
const a: string[] = aa;
const b: string[] = ga;
const c: [string, string] = pair;
take(aa);
function list(): string[] { return ga; }
const d: G<string> = rows;
type Box = { rows: AA[]; plain: any[] };
declare const box: Box;
declare const nested: AA[];
const e: string[][] = box.rows;
const f: string[] = box.plain;
const g: string[][] = nested;
function toAlias(): G<string> { return rows; }
function toReadonly(): readonly string[] { return rows; }
function toTuple(): [string, string] { return pair; }
function toSame(): AA { return aa; }
function toUnknown(): unknown[] { return aa; }
function toNested(): string[][] { return nested; }
const [h]: string[] = aa;
const [i, j]: [string, string] = pair;
function first([k]: string[] = ga): string { return k; }
const { plain: [m] }: { plain: string[] } = box;
void [a, b, c, d, e, f, g, h, i, j, m, list, toAlias, toReadonly, toTuple, toSame, toUnknown, toNested, first];
`;

test("an aliased any array or tuple, as in type AA = any[] or G<any>, assigned or passed is left alone, and one destructured through an annotated pattern or an any[] returned into anything but unknown[] is reported, on the same lines tsgolint reports in a .ts file (fails if a deferred reference such as an alias is compared by its generic target, an annotated pattern or a parameter default pattern is not destructured, or a returned any[] is compared by target rather than by its declared return)", () => {
  const expected = [13, 19, 21, 22, 27, 28, 29, 30];
  assert.deepEqual(parityLines("Aliased", aliased), {
    ts: expected,
    vue: expected,
  });
});

const callbacks = `declare const parsedAny: any;
declare const rows: any[];
declare function on(handler: () => unknown): void;
declare function later(handler: () => Promise<unknown>): void;
rows.map((v) => v);
const f: () => any = () => parsedAny;
rows.map((v) => {
  return v;
});
const g = (): any => parsedAny;
on(() => parsedAny);
later(async () => parsedAny);
const h = function () {
  return parsedAny;
};
rows.map(() => rows);
declare function list(handler: () => unknown[]): void;
list(() => rows);
function copy() { return rows; }
declare const pair: [any, string];
declare function both(handler: () => [string, string]): void;
both(() => pair);
declare const frozen: readonly [any];
const once: () => readonly [string] = () => frozen;
declare function either(handler: (() => any) | (() => unknown)): void;
either(() => parsedAny);
declare function overloaded(handler: { (): any; (x: number): unknown }): void;
overloaded(() => parsedAny);
declare function firstOverload(handler: { (): [string]; (x: number): [unknown] }): void;
firstOverload(() => frozen as [any]);
declare function firstMember(handler: (() => [string]) | (() => [unknown])): void;
firstMember(() => frozen as [any]);
declare function merged(handler: (() => any) & (() => unknown)): void;
merged(() => parsedAny);
const tagged: (() => unknown) & { tag?: string } = () => parsedAny;
void [f, g, h, copy, once, tagged];
`;

test("an unannotated callback returning any or any[] is reported unless a signature of its context returns unknown or unknown[], and one whose own annotation returns any is not, on the same lines tsgolint reports in a .ts file (fails if a contextual any or any[] return counts as declared, a tuple holding any is not compared with its contextual tuple, an unannotated async callback's contextual Promise is awaited, only the first or merged contextual signature is read for an any, a tuple is compared with a signature other than the first, or an intersection of callables lends its signatures)", () => {
  const expected = [5, 6, 8, 12, 14, 16, 19, 22, 24, 30, 32, 34];
  assert.deepEqual(parityLines("Callbacks", callbacks), {
    ts: expected,
    vue: expected,
  });
});
