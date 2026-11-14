import assert from "node:assert/strict";
import { test } from "node:test";

import { parityLines } from "./helpers/unsafe-any-parity.ts";

const defaults = `declare const parsedAny: any;
let x: string;
let u: unknown;
const { a = parsedAny } = {} as { a?: any };
const { n: { b2 } = { b2: parsedAny } } = {} as { n?: { b2: string } };
({ x = parsedAny } = {} as { x?: any });
({ u = parsedAny } = {} as { u?: any });
const [[d] = [parsedAny]] = [] as [[string]?];
const { s: { t } = {} as { t: any } } = {} as { s?: { t: string } };
({ m: { x } = { x: "" } } = {} as { m: { x: any } });
void [a, b2, d, t];
`;

test("an any default into an any slot is reported for the slot and for the default, a nested pattern is destructured from its own default, and one with a default is not destructured from its source, on the lines tsgolint reports (fails if an any slot whose default is any is reported once, a binding element's default is not destructured, or a nested pattern with a default reads its source's slots)", () => {
  const expected = [4, 4, 5, 5, 6, 6, 7, 8, 9];
  assert.deepEqual(parityLines("Defaults", defaults), {
    ts: expected,
    vue: expected,
  });
});

const generics = `declare const anySet: Set<any>;
declare const anyMap: Map<string, any>;
declare const pAny: Promise<any>;
declare function take(s: Set<string>): void;
interface Box<T> { value: T }
declare const box: Box<any>;
type Alias<T> = Set<T>;
declare const aliased: Alias<any>;
const s: Set<string> = anySet;
const m: Map<string, number> = anyMap;
take(anySet);
function ret(): Set<string> { return anySet; }
const b: Box<string> = box;
const fresh: Map<string, number> = new Map();
const freshArgs: Map<string, number> = new Map<any, any>();
const nested: Set<Set<string>> = new Set<Set<any>>();
const p: Promise<string> = pAny;
const al: Set<string> = aliased;
const ro: ReadonlySet<string> = anySet;
const u: Set<unknown> = anySet;
const parens: Map<string, number> = (new Map());
declare const deep: Set<Set<Set<Set<Set<Set<any>>>>>>;
const deepTyped: Set<Set<Set<Set<Set<Set<string>>>>>> = deep;
void [s, m, ret, b, fresh, freshArgs, nested, p, al, ro, u, parens, deepTyped];
`;

test("an any inside a generic reference other than an array or tuple, as in Set<any>, Map<string, any> or Box<any>, assigned, passed or returned into the same generic with another type there is reported, and new Map(), an alias, another target and an unknown slot are not, on the lines tsgolint reports (fails if only array and tuple references are compared, new Map() is not let into a Map, a parenthesized new Map() is let in too, or the comparison stops at a fixed depth)", () => {
  const expected = [9, 10, 11, 12, 13, 15, 16, 17, 21, 23];
  assert.deepEqual(parityLines("Generics", generics), {
    ts: expected,
    vue: expected,
  });
});

const asyncReturns = `declare const rows: any[];
declare const pAny: Promise<any>;
async function toUnknowns(): Promise<unknown[]> { return rows; }
async function toString(): Promise<string> { return pAny; }
function syncPromise(): Promise<string> { return pAny; }
async function toUnknown(): Promise<unknown> { return pAny; }
function toPlainUnknowns(): unknown[] { return rows; }
async function toAnys(): Promise<any[]> { return rows; }
declare function later(handler: () => Promise<unknown[]>): void;
later(async () => rows);
void [toUnknowns, toString, syncPromise, toUnknown, toPlainUnknowns, toAnys];
`;

test("an any[] returned from an async function declared Promise<unknown[]> and a Promise<any> returned from one declared Promise<string> are reported, and a Promise<any> a function not async returns is not, on the lines tsgolint reports (fails if the declared Promise is awaited before the unknown[] exemption, a Promise<any> is not told from a safe value, or a function not async is judged by the awaited Promise)", () => {
  const expected = [3, 4, 10];
  assert.deepEqual(parityLines("AsyncReturns", asyncReturns), {
    ts: expected,
    vue: expected,
  });
});

const uncontextual = `declare const parsedAny: any;
declare function on(handler: () => unknown): void;
const property = { handler: () => parsedAny };
const list = [() => parsedAny];
const cast = (() => parsedAny) as () => unknown;
const checked = (() => parsedAny) satisfies () => unknown;
const picked = Math.random() ? () => parsedAny : () => 1;
const wrapped: () => unknown = (() => parsedAny);
function factory(): () => unknown { return () => parsedAny; }
on(() => parsedAny);
const typed: () => unknown = () => parsedAny;
let later: () => unknown;
later = () => parsedAny;
void [property, list, cast, checked, picked, wrapped, factory, typed, later];
`;

test("an any-returning callback in an object literal, an array, as, satisfies, a conditional, parentheses or a factory's return is judged by its own any return, and one passed, annotated or assigned by its context, on the lines tsgolint reports (fails if every function expression is judged by its checker contextual type)", () => {
  const expected = [3, 4, 5, 6, 7, 8, 9];
  assert.deepEqual(parityLines("Uncontextual", uncontextual), {
    ts: expected,
    vue: expected,
  });
});

const annotated = `declare const parsedAny: any;
declare const a: any;
declare function on(handler: () => unknown): void;
declare function want(handler: () => string): void;
on((): string => parsedAny);
want((): any => a);
const loose: () => unknown = (): string => parsedAny;
const strict: () => string = (): any => a;
on((): any => a);
want((): string => parsedAny);
const own = (): string => parsedAny;
void [loose, strict, own];
`;

test("an annotated callback is excused by a context that returns its own type, any or unknown and reported against another, so (): string => any into () => unknown is not reported and (): any => a into () => string is, on the lines tsgolint reports (fails if an annotated callback is judged by its own annotation rather than its context's signatures)", () => {
  const expected = [6, 8, 10, 11];
  assert.deepEqual(parityLines("Annotated", annotated), {
    ts: expected,
    vue: expected,
  });
});

const declarations = `declare const parsedAny: any;
class Store {
  get unknownValue(): unknown { return parsedAny; }
  get anyValue(): any { return parsedAny; }
  get inferred() { return parsedAny; }
  method(): unknown { return parsedAny; }
}
function pick(x: string): string;
function pick(x: number): number;
function pick(x: any) { return x; }
function loose(): unknown;
function loose() { return parsedAny; }
function strict(): string;
function strict(): any { return parsedAny; }
const object = { get value(): unknown { return parsedAny; }, read(): unknown { return parsedAny; } };
void [Store, pick, loose, strict, object];
`;

test("a getter returning any is reported whatever it declares, a method is judged by its own signature, and an overload implementation by its overloads, on the lines tsgolint reports (fails if a getter is judged by its return annotation, or an overload implementation by its own signature rather than the overloads)", () => {
  const expected = [3, 4, 5, 10, 14, 15];
  assert.deepEqual(parityLines("Declarations", declarations), {
    ts: expected,
    vue: expected,
  });
});

const unionOrder = `declare const frozen: readonly [any];
type Strings = () => [string];
type Unknowns = () => [unknown];
const early: Unknowns = () => [1];
declare function later(handler: Strings | Unknowns): void;
later(() => frozen as [any]);
type Alpha = () => [unknown];
type Beta = () => [string];
declare function byName(handler: Beta | Alpha): void;
byName(() => frozen as [any]);
declare function namedFirst(handler: (() => [unknown]) | Beta): void;
namedFirst(() => frozen as [any]);
declare function inline(handler: (() => [unknown]) | (() => [string])): void;
inline(() => frozen as [any]);
void early;
`;

test("a tuple returned into a union context is compared with the member tsgo orders first, named types by name before unnamed ones and unnamed ones by position, whatever an earlier line creates first, on the lines tsgolint reports (fails if the members are read in the TypeScript 6 checker's type creation order)", () => {
  const expected = [6, 12];
  assert.deepEqual(parityLines("UnionOrder", unionOrder), {
    ts: expected,
    vue: expected,
  });
});
