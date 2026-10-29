import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";

import { normalizeBundle } from "./declaration-order.ts";

const norm = (text: string): string => normalizeBundle(ts, text);

test("declarations differing only in object type literal member order compare equal", () => {
  assert.equal(
    norm(
      "export type Options = { mono: boolean; actions: string[]; badge?: string };",
    ),
    norm(
      "export type Options = { actions: string[]; badge?: string; mono: boolean };",
    ),
  );
});

test("interface members, methods and index signatures compare regardless of order", () => {
  assert.equal(
    norm(
      "export interface Api { [key: string]: unknown; run(): void; name: string; new (x: number): Api; (y: string): void }",
    ),
    norm(
      "export interface Api { name: string; (y: string): void; run(): void; new (x: number): Api; [key: string]: unknown }",
    ),
  );
});

test("nested object literals inside unions, generics and function types are normalised", () => {
  assert.equal(
    norm(
      "export type T = Array<{ b: 1; a: { d: 1; c: 2 } }> | Promise<{ y: 1; x: 2 }> | ((arg: { q: 1; p: 2 }) => { n: 1; m: 2 });",
    ),
    norm(
      "export type T = Array<{ a: { c: 2; d: 1 }; b: 1 }> | Promise<{ x: 2; y: 1 }> | ((arg: { p: 2; q: 1 }) => { m: 2; n: 1 });",
    ),
  );
});

test("class member order does not matter but static and instance members stay distinct", () => {
  assert.equal(
    norm(
      "export declare class C { b: number; static a: number; constructor(x: number); c(): void }",
    ),
    norm(
      "export declare class C { constructor(x: number); c(): void; static a: number; b: number }",
    ),
  );
  assert.notEqual(
    norm("export declare class C { a: number }"),
    norm("export declare class C { static a: number }"),
  );
});

test("a changed property type, optionality or readonly still differs", () => {
  const base = "export type T = { a: string; b: number };";
  assert.notEqual(
    norm(base),
    norm("export type T = { a: string; b: string };"),
  );
  assert.notEqual(
    norm(base),
    norm("export type T = { a: string; b?: number };"),
  );
  assert.notEqual(
    norm(base),
    norm("export type T = { a: string; readonly b: number };"),
  );
  assert.notEqual(norm(base), norm("export type T = { a: string };"));
  assert.notEqual(
    norm("export type T = { a: { x: 1; y: 2 }; b: 3 };"),
    norm("export type T = { b: 3; a: { x: 1; y: 3 } };"),
  );
});

test("tuple elements, parameters, overloads and enum members keep their order", () => {
  assert.notEqual(
    norm("export type T = [string, number];"),
    norm("export type T = [number, string];"),
  );
  assert.notEqual(
    norm("export declare function f(a: string, b: number): void;"),
    norm("export declare function f(b: number, a: string): void;"),
  );
  assert.notEqual(
    norm("export interface I { m(a: string): 1; m(a: number): 2 }"),
    norm("export interface I { m(a: number): 2; m(a: string): 1 }"),
  );
  assert.notEqual(
    norm("export interface I { (a: string): 1; (a: number): 2 }"),
    norm("export interface I { (a: number): 2; (a: string): 1 }"),
  );
  assert.notEqual(
    norm("export enum E { A, B }"),
    norm("export enum E { B, A }"),
  );
  assert.notEqual(
    norm("export interface I { (a: string): 1 }"),
    norm("export interface I { (a: number): 1 }"),
  );
});

test("declarations differing only in union constituent order compare equal, at any depth", () => {
  assert.equal(
    norm("export type T = { b: 1 } | { a: 1 } | null;"),
    norm("export type T = null | { a: 1 } | { b: 1 };"),
  );
  assert.equal(
    norm(
      "export declare function f(x: 'b' | 'a'): Promise<{ y: 2 | 1; x: 'q' | 'p' } | undefined>;",
    ),
    norm(
      "export declare function f(x: 'a' | 'b'): Promise<undefined | { x: 'p' | 'q'; y: 1 | 2 }>;",
    ),
  );
});

test("a changed, added or removed union constituent still differs", () => {
  assert.notEqual(
    norm("export type T = 'a' | 'b' | 'c';"),
    norm("export type T = 'c' | 'b' | 'd';"),
  );
  assert.notEqual(
    norm("export type T = 'a' | 'b';"),
    norm("export type T = 'b' | 'a' | 'c';"),
  );
  assert.notEqual(
    norm("export type T = { a: 1 } | { b: 1 };"),
    norm("export type T = { a: 1 } | { b: 2 };"),
  );
});

test("intersection constituents keep their order, because function intersections are overloads", () => {
  assert.notEqual(
    norm("export type F = ((a: string) => 1) & ((a: number) => 2);"),
    norm("export type F = ((a: number) => 2) & ((a: string) => 1);"),
  );
});
