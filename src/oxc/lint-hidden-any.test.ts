import assert from "node:assert/strict";
import { test } from "node:test";

import { lintProject } from "./helpers/lint-project.ts";

const HIDDEN_ANY_RULES = [
  "typescript(no-unnecessary-type-parameters)",
  "typescript(no-unsafe-assignment)",
  "typescript(no-unsafe-return)",
  "typescript(use-unknown-in-catch-callback-variable)",
];

const singleUseGenerics = `
interface StandInResponse { status: number; body?: unknown }

/** stripe: IsStripeId<T>(field: string | T), unknown relabelled as T. */
export function IsStripeId<T>(field: string | T): field is string {
  return field !== null && field?.constructor === String;
}

/** mollie@932eb5f:src/test/stand-in/responses.ts, Ok<T>(body: T) landing in body?: unknown. */
export function Ok<T>(body: T, status = 200): StandInResponse {
  return { status, body };
}

/** interface-core: replayErrorReporter<Id>(id: Id). */
export function replayErrorReporter<Id>(id: Id): void {
  console.error(id);
}

/** interface-api: computeParameter<Owner>(obj: Owner). */
export class Parameters {
  computeParameter<Owner extends object>(obj: Owner, key: string): string {
    return key in obj ? key : "";
  }
}

/** dms-automation #86: assertRegistered<T>(type: T, id). */
export function assertRegistered<T>(type: T, id: string): void {
  if (id === "") throw new Error(\`unregistered \${String(type)}\`);
}

/** postgres@9b034c9:src/test-external/refusals.test.ts, Refusal<T extends PromiseLike<unknown>>(work: () => T). */
export async function Refusal<T extends PromiseLike<unknown>>(work: () => T): Promise<string> {
  try {
    await work();
  } catch (err) {
    if (err instanceof Error) return err.message;
  }
  return "";
}

/** dms-builder #72: loadModule<BaseModule> around require, replacing factory as BlockFactory. */
export function loadModule<T = Record<string, unknown>>(specifier: string): T {
  return require(specifier);
}
`;

const typedAnySources = `
interface PackageManifest { version: string }
type DataValue = string | number | boolean | null | DataValue[] | { [key: string]: DataValue };

/** dms-database #65: const parsed: PackageManifest = JSON.parse(manifest). */
export function manifestVersion(manifest: string): string {
  const parsed: PackageManifest = JSON.parse(manifest);
  return parsed.version;
}

/** dms-automation #86: parseJsonText returning JSON.parse as DataValue. */
export function parseJsonText(text: string): DataValue {
  return JSON.parse(text);
}

/** dms-automation realtime.ts:27, a catch callback inferring any. */
export function relay(publish: Promise<void>): void {
  publish.catch((err) => console.error(err.message));
}
`;

const ordinaryCode = `
interface PackageManifest { version: string }

export function identity<T>(value: T): T {
  return value;
}

export function first<T>(items: readonly T[]): T | undefined {
  return items[0];
}

export function byKey<T, K extends keyof T>(items: readonly T[], key: K): T[K][] {
  return items.map((item) => item[key]);
}

export function isManifest(value: unknown): value is PackageManifest {
  return value !== null && typeof value === "object" && "version" in value;
}

export function manifestVersion(manifest: string): string {
  const parsed: unknown = JSON.parse(manifest);
  if (!isManifest(parsed)) throw new TypeError("not a package manifest");
  return parsed.version;
}

export function relay(publish: Promise<void>): void {
  publish.catch((err: unknown) => console.error(err));
}

export function parseCount(text: string): number {
  return Number.parseInt(text, 10);
}
`;

function hiddenAnyFindings(files: Record<string, string>): string[] {
  const project = lintProject(true);
  try {
    for (const [path, source] of Object.entries(files))
      project.write(path, source);
    const result = project.run();
    return result.diagnostics
      .filter(
        (diagnostic: { code: string; filename: string }) =>
          HIDDEN_ANY_RULES.includes(diagnostic.code) &&
          Object.hasOwn(files, diagnostic.filename),
      )
      .map(
        (diagnostic: {
          code: string;
          filename: string;
          labels: { span: { line: number } }[];
        }) =>
          `${diagnostic.filename}:${diagnostic.labels[0]?.span.line} ${diagnostic.code}`,
      )
      .toSorted();
  } finally {
    project.remove();
  }
}

test("single-use type parameters that hide unknown fail (stripe, mollie, interface-core, interface-api, dms-automation #86, postgres refusals, dms-builder #72)", () => {
  assert.deepEqual(hiddenAnyFindings({ "generics.ts": singleUseGenerics }), [
    "generics.ts:10 typescript(no-unnecessary-type-parameters)",
    "generics.ts:15 typescript(no-unnecessary-type-parameters)",
    "generics.ts:21 typescript(no-unnecessary-type-parameters)",
    "generics.ts:27 typescript(no-unnecessary-type-parameters)",
    "generics.ts:32 typescript(no-unnecessary-type-parameters)",
    "generics.ts:42 typescript(no-unnecessary-type-parameters)",
    "generics.ts:43 typescript(no-unsafe-return)",
    "generics.ts:5 typescript(no-unnecessary-type-parameters)",
  ]);
});

test("any bound to a typed local, a typed return or a catch callback fails (dms-database #65, dms-automation #86)", () => {
  assert.deepEqual(hiddenAnyFindings({ "sources.ts": typedAnySources }), [
    "sources.ts:13 typescript(no-unsafe-return)",
    "sources.ts:18 typescript(use-unknown-in-catch-callback-variable)",
    "sources.ts:7 typescript(no-unsafe-assignment)",
  ]);
});

test("generics used twice, unknown narrowed by a guard and typed catch callbacks pass", () => {
  assert.deepEqual(hiddenAnyFindings({ "ordinary.ts": ordinaryCode }), []);
});
