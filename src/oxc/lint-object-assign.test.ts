import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "@typescript/typescript6";

import { lintProject } from "./helpers/lint-project.ts";

const RULE = "antelopejs(no-unsafe-object-assign)";

const proxy = `
export interface QueryStage { kind: string }
export interface ValueProxy<T> {
  stages: QueryStage[];
  value?: T;
  status: "idle" | "loading";
  add(amount: T): ValueProxy<T>;
}
export class Box {
  get size(): number { return 0; }
  set size(next: number | string) {}
}
export interface Shapes {
  byName: Record<string, QueryStage>;
  pair: [number, string];
  ids: string[] | number[];
  shape: { kind: "circle"; r: number } | { kind: "square"; side: number };
}
export type Cell<T> = { get items(): readonly T[]; set items(next: Iterable<T>) };
export interface Deep { a: { b: { c: { d: { e: { status: "idle" | "loading" } } } } } }
`;

const holes = `
import type { QueryStage, ValueProxy } from "./proxy.ts";

declare const junk: unknown;
declare const receiver: ValueProxy<number>;

/** tooling-configs#116: interface-database 0.3.0, an unknown element written over QueryStage[]. */
export const hole: QueryStage[] = Object.assign(receiver.add(0), { stages: [junk] }).stages;

/** dms-database decodeStaged: { stages: rebuilt } with rebuilt: unknown. */
export function decodeStaged(rebuilt: unknown): ValueProxy<number> {
  return Object.assign(receiver.add(0), { stages: rebuilt });
}

/** mongodb startup.test.ts: JSON.parse written over a typed field. */
export function restore(text: string): ValueProxy<number> {
  return Object.assign(receiver.add(0), { stages: JSON.parse(text) });
}

/** A whole unknown source overwrites every typed field. */
export function merge(patch: unknown): ValueProxy<number> {
  return Object.assign(receiver.add(0), patch);
}

/** A typed value of the wrong type, in a later source, after a non-ASCII “quote”. */
export function mislabel(): ValueProxy<number> {
  return Object.assign(receiver.add(0), {}, { value: "one" });
}

declare const loose: any;
declare const flag: boolean;

/** An optional source property that may hold null, over a field that does not take null. */
export function nullable(update: { stages?: QueryStage[] | null }): ValueProxy<number> {
  return Object.assign(receiver.add(0), update);
}

/** The seeded write behind a condition. */
export function conditional(): ValueProxy<number> {
  return Object.assign(receiver.add(0), flag && { stages: [junk] });
}

/** An any element inside the written value, which no-unsafe-assignment reports on a direct write. */
export function nested(): ValueProxy<number> {
  return Object.assign(receiver.add(0), { stages: [loose] });
}

/** Unknown values under an index signature overwrite every field. */
export function entries(pairs: [string, unknown][]): ValueProxy<number> {
  return Object.assign(receiver.add(0), Object.fromEntries(pairs));
}

/** Nested literals a direct assignment rejects: a missing or misspelled property, unknown under a record, tuple order and length, mixed unions. */
export function shaped(shapes: import("./proxy.ts").Shapes): void {
  Object.assign(receiver.add(0), { stages: [{}] });
  Object.assign(receiver.add(0), { stages: [{ kid: "match" }] });
  Object.assign(shapes, { byName: { first: junk } });
  Object.assign(shapes, { pair: [1, 2] }, { pair: [1] });
  Object.assign(shapes, { ids: ["a", 1] });
  Object.assign(shapes, { shape: { kind: "circle", side: 1 } });
}

/** A type-parameter source, read through its constraint. */
export function apply<P extends { stages: unknown }>(patch: P): ValueProxy<number> {
  return Object.assign(receiver.add(0), patch);
}
`;

const checked = `
import { Box, type ValueProxy } from "./proxy.ts";

declare class Client { connect(): void }
declare const query: (sql: string) => Promise<void>;

/** tooling-configs#116: target has no code property. */
export function failure(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/** tooling-configs#116: target has no query property. */
export const client = Object.assign(new Client(), { query });

/** tooling-configs#116: a source assignable to Partial<typeof target>. */
export function patch(target: ValueProxy<number>, update: Partial<ValueProxy<number>>): ValueProxy<number> {
  return Object.assign(target, update);
}

/** Assignable fields, a fresh target, and a spread source. */
export function rebuild(target: ValueProxy<number>, extra: object[]): ValueProxy<number> {
  const copy = Object.assign({}, target);
  Object.assign(copy, ...extra);
  return Object.assign(target, { value: 1, stages: [{ kind: "match" }] });
}

/** A literal written over a literal-union field, and a string through a setter that takes one. */
export function literal(target: ValueProxy<number>): Box {
  Object.assign(target, { status: "loading" });
  return Object.assign(new Box(), { size: "3" });
}

/** A record of numbers, an optional undefined, and an any field that takes any. */
export function loose(target: { stages: unknown[]; extra?: any }, counts: Record<string, number>, update: { stages?: unknown[] }): object {
  Object.assign(target, update, { extra: JSON.parse("1") });
  return Object.assign({ total: 0 }, counts);
}

/** A class filled from a partial of itself, whose methods return \`this\`. */
export class Model {
  count = 0;
  constructor(init: Partial<Model>) {
    Object.assign(this, init);
  }
  update(patch: Partial<this>): this {
    return Object.assign(this, patch);
  }
}

declare const flag: boolean;
declare const prefixed: Record<\`data-\${string}\`, unknown>;
declare const symbols: { [key: symbol]: unknown };
declare const list: unknown[];

/** Index signatures whose keys cannot name a declared field, or a target whose fields all take unknown. */
export function keyed(target: ValueProxy<number>, open: { a: unknown }, record: Record<string, unknown>): object {
  Object.assign(target, prefixed, symbols, list);
  return Object.assign(open, record);
}

/** A setter of a generic class, a shorthand const literal, nested literals, and a condition over Date. */
export class Collection<T> {
  get items(): readonly T[] { return []; }
  set items(next: Iterable<T>) {}
}
export function forms(target: ValueProxy<number>, collection: Collection<number>): object {
  const status = "loading";
  Object.assign(target, { status }, { stages: [{ kind: "match" }] });
  Object.assign(collection, { items: new Set([1]) });
  return Object.assign(new Date(), flag && { stamp: 1 });
}

/** A setter in a generic type alias, and a literal nested past the depth the rule compares. */
export function aliased(cell: import("./proxy.ts").Cell<number>, deep: import("./proxy.ts").Deep): object {
  Object.assign(cell, { items: new Set([1]) });
  return Object.assign(deep, { a: { b: { c: { d: { e: { status: "idle" } } } } } });
}
`;

function findings(files: Record<string, string>): string[] {
  const project = lintProject(true);
  try {
    for (const [path, source] of Object.entries(files))
      project.write(path, source);
    const result = project.run();
    return result.diagnostics
      .filter((diagnostic: { code: string }) => diagnostic.code === RULE)
      .map(
        (diagnostic: {
          filename: string;
          labels: { span: { line: number } }[];
        }) => `${diagnostic.filename}:${diagnostic.labels[0]?.span.line}`,
      )
      .toSorted();
  } finally {
    project.remove();
  }
}

test("Object.assign writing unknown, any or a mistyped value over a typed field fails (tooling-configs#116)", () => {
  assert.deepEqual(findings({ "proxy.ts": proxy, "holes.ts": holes }), [
    "holes.ts:12",
    "holes.ts:17",
    "holes.ts:22",
    "holes.ts:27",
    "holes.ts:35",
    "holes.ts:40",
    "holes.ts:45",
    "holes.ts:50",
    "holes.ts:55",
    "holes.ts:56",
    "holes.ts:57",
    "holes.ts:58",
    "holes.ts:58",
    "holes.ts:59",
    "holes.ts:60",
    "holes.ts:65",
    "holes.ts:8",
  ]);
});

test("an optional property that may hold undefined fails under exactOptionalPropertyTypes", () => {
  const exact = JSON.stringify({
    compilerOptions: { strict: true, exactOptionalPropertyTypes: true },
  });
  const source = `
import type { ValueProxy } from "./proxy.ts";

export function patch(target: ValueProxy<number>, update: { value?: number | undefined }): ValueProxy<number> {
  return Object.assign(target, update);
}
`;
  assert.deepEqual(
    findings({ "tsconfig.json": exact, "proxy.ts": proxy, "exact.ts": source }),
    ["exact.ts:5"],
  );
});

test(
  "two files whose names differ only in case stay two types (fails when parsed files are shared by a case-folded path)",
  { skip: !ts.sys.useCaseSensitiveFileNames },
  () => {
    const token = "export class Token { private brand = 1; value = 0; }\n";
    const source = `
import type { Token as Upper } from "./Token.ts";
import type { Token as Lower } from "./token.ts";

export function swap(holder: { token: Upper }, lower: Lower): object {
  return Object.assign(holder, { token: lower });
}
`;
    assert.deepEqual(
      findings({ "Token.ts": token, "token.ts": token, "swap.ts": source }),
      ["swap.ts:6"],
    );
  },
);

test("Object.assign adding new fields, writing assignable values or copying into a fresh object passes", () => {
  assert.deepEqual(findings({ "proxy.ts": proxy, "checked.ts": checked }), []);
});

test("a component the tsconfig lists keeps its declarations to itself, so a .ts file's global type is unchanged (fails if a component without imports is read as a global script)", () => {
  assert.deepEqual(
    findings({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          module: "esnext",
          moduleResolution: "bundler",
          types: [],
        },
      }),
      "types/global.d.ts": "interface Item { count: number }\n",
      "src/use.ts":
        "export function bump(item: Item, next: number): void {\n  Object.assign(item, { count: next });\n}\n",
      "app/Counter.vue":
        '<template><p>{{ label.count }}</p></template>\n\n<script setup lang="ts">\ninterface Item { count: string }\nconst label: Item = { count: "" };\n</script>\n',
    }),
    [],
  );
});
