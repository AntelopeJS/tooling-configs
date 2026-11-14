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
void [s, m, ret, b, fresh, freshArgs, nested, p, al, ro, u, parens];
`;

test("an any inside a generic reference other than an array or tuple, as in Set<any>, Map<string, any> or Box<any>, assigned, passed or returned into the same generic with another type there is reported, and new Map(), an alias, another target and an unknown slot are not, on the lines tsgolint reports (fails if only array and tuple references are compared, new Map() is not let into a Map, or a parenthesized new Map() is let in too)", () => {
  const expected = [9, 10, 11, 12, 13, 15, 16, 17, 21];
  assert.deepEqual(parityLines("Generics", generics), {
    ts: expected,
    vue: expected,
  });
});
