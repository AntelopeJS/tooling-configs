import assert from "node:assert/strict";
import { test } from "node:test";

import { lintProject } from "./helpers/lint-project.ts";

const guards = `
interface RealtimeEvent { topic: string; type: string }
interface CatalogEntry { id: string; category: string }

/** antelopejs@cb937e5:src/utils/type-guards.ts:10, a predicate arrow built by a factory. */
export function hasTypeofTag(tag: "string" | "number") {
  return (value: unknown): value is string | number => typeof value === tag;
}

/** dms@eeb25342:packages/dms/src/realtime/redis-broker.ts:82 */
export const isRealtimeEvent = (value: unknown): value is RealtimeEvent =>
  !!value &&
  typeof value === "object" &&
  "topic" in value &&
  typeof value.topic === "string" &&
  "type" in value &&
  typeof value.type === "string";

/** dms@eeb25342:packages/dms/src/store/catalog.ts:25 */
export function isCatalogEntry(value: unknown): value is CatalogEntry {
  return (
    value !== null &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "string" &&
    "category" in value &&
    typeof value.category === "string"
  );
}

/** An assertion function decodes as a predicate does. */
export function assertString(value: unknown): asserts value is string {
  if (typeof value !== "string") throw new TypeError("expected a string");
}
`;

const decodersOutsideGuards = `
interface PresenceEntry { topic: string; rowId: string }

/** dms@eeb25342:packages/dms/src/realtime/presence.ts:79, a parser that returns the value, not a predicate. */
export const parsePresenceEntry = (value: string): PresenceEntry | undefined => {
  const parsed: PresenceEntry = JSON.parse(value);
  if (typeof parsed.topic === "string" && typeof parsed.rowId === "string") {
    return parsed;
  }
  return undefined;
};

/** dms@eeb25342:packages/dms/src/utils/upload-token.ts:98, a claim read inline. */
export function storageClaim(payload: { storage?: string }): string | undefined {
  return typeof payload.storage === "string" ? payload.storage : undefined;
}

/** A callback inside a guard is its own function, without a predicate. */
export function isStringList(value: readonly string[] | number): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
`;

test("typeof is accepted in predicate and assertion functions but flagged in parsers, inline reads and callbacks", () => {
  const project = lintProject();
  try {
    project.write("guards.ts", guards);
    project.write("decoders.ts", decodersOutsideGuards);
    const result = project.run();
    const typeofLines = result.diagnostics
      .filter(
        (diagnostic: { code: string }) =>
          diagnostic.code === "anti-slop(no-runtime-typeof)",
      )
      .map(
        (diagnostic: {
          filename: string;
          labels: { span: { line: number } }[];
        }) => `${diagnostic.filename}:${diagnostic.labels[0]?.span.line}`,
      );
    assert.deepEqual(typeofLines.toSorted(), [
      "decoders.ts:15",
      "decoders.ts:20",
      "decoders.ts:7",
      "decoders.ts:7",
    ]);
  } finally {
    project.remove();
  }
});
