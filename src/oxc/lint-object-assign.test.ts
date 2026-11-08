import assert from "node:assert/strict";
import { test } from "node:test";

import { lintProject } from "./helpers/lint-project.ts";

const RULE = "antelopejs(no-unsafe-object-assign)";

const proxy = `
export interface QueryStage { kind: string }
export interface ValueProxy<T> {
  stages: QueryStage[];
  value?: T;
  add(amount: T): ValueProxy<T>;
}
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
`;

const checked = `
import type { ValueProxy } from "./proxy.ts";

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
    "holes.ts:8",
  ]);
});

test("Object.assign adding new fields, writing assignable values or copying into a fresh object passes", () => {
  assert.deepEqual(findings({ "proxy.ts": proxy, "checked.ts": checked }), []);
});
