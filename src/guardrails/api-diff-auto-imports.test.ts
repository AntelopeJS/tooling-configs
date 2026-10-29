import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  PACKAGE_ROOT,
  bin,
  commit,
  put,
  testRepo,
} from "./helpers/test-repo.ts";

const FRONTEND = "packages/dms/frontend-vue";
const OPERATORS = `${FRONTEND}/layers/dms-core/app/types/row-action-operators.ts`;
const EVALUATOR = `${FRONTEND}/layers/dms-core/app/utils/row-action-rule-evaluator.ts`;
const BUCKETS = `${FRONTEND}/layers/dms-ui/app/composables/chart/apexDatetimeBuckets.ts`;

const OPERATORS_SOURCE = `export const FIELD_KEY = "field" as const;
export const LOGICAL_OPERATOR_KEYS = ["and", "or", "not"] as const;
export type LogicalOperatorKey = (typeof LOGICAL_OPERATOR_KEYS)[number];
`;

const EVALUATOR_SOURCE = `import { FIELD_KEY, LOGICAL_OPERATOR_KEYS } from "#dms-core/app/types/row-action-operators";

function present(rule: Record<string, unknown>, key: string): boolean {
  return key in rule;
}

export function evaluateRowActionRule(rule: Record<string, unknown>): boolean {
  return LOGICAL_OPERATOR_KEYS.some((key) => present(rule, key)) || present(rule, FIELD_KEY);
}
`;

const BUCKETS_SOURCE = `export interface DatetimeBuckets {
  bucket: "day" | "month";
}

export function bucketAxisFormatter(
  buckets: DatetimeBuckets,
): (value: string, timestamp?: unknown) => string {
  return (value) => \`\${buckets.bucket}:\${value}\`;
}
`;

/** A frontend module reduced from AntelopeJS/dms at the #526 base: a private package whose layers publish their `app/composables`, `app/utils` and `app/types` exports through `dms.frontend.build.ts`. */
function frontendRepo(t: Parameters<typeof testRepo>[0]): string {
  const root = testRepo(t);
  symlinkSync(
    join(PACKAGE_ROOT, "node_modules"),
    join(root, "node_modules"),
    "dir",
  );
  put(
    root,
    `${FRONTEND}/package.json`,
    JSON.stringify({
      name: "@antelopejs/dms-frontend-vue",
      private: true,
      type: "module",
    }),
  );
  put(
    root,
    `${FRONTEND}/dms.frontend.build.ts`,
    `import { defineDmsFrontendBuild } from "#dms/frontend-build";

export default defineDmsFrontendBuild((build) => {
  build.registerAutoImports([
    "layers/*/app/composables",
    "layers/*/app/utils",
    "layers/*/app/types",
  ]);
});
`,
  );
  put(root, OPERATORS, OPERATORS_SOURCE);
  put(root, EVALUATOR, EVALUATOR_SOURCE);
  put(root, BUCKETS, BUCKETS_SOURCE);
  put(
    root,
    `${FRONTEND}/layers/dms-core/app/build/utils/privateHelper.ts`,
    "export function privateHelper(value: string): string {\n  return value;\n}\n",
  );
  commit(root);
  execFileSync("git", ["tag", "base"], { cwd: root });
  return root;
}

function apiDiff(root: string, args: string[] = []) {
  const result = bin(root, "api-diff", ["base", ...args]);
  return { ...result, text: result.stdout + result.stderr };
}

test("api-diff fails when a published auto-import is deleted because it has no local user (dms#526 LOGICAL_OPERATOR_KEYS)", (t) => {
  const root = frontendRepo(t);
  put(
    root,
    OPERATORS,
    OPERATORS_SOURCE.replace(
      /^export const LOGICAL_OPERATOR_KEYS.*\n/mu,
      'const LOGICAL_OPERATOR_KEYS = ["and", "or", "not"] as const;\n',
    ),
  );
  put(
    root,
    EVALUATOR,
    EVALUATOR_SOURCE.replace(", LOGICAL_OPERATOR_KEYS", "").replace(
      "LOGICAL_OPERATOR_KEYS.some((key) => present(rule, key))",
      '["and", "or", "not"].some((key) => present(rule, key))',
    ),
  );
  commit(root);
  const result = apiDiff(root);
  assert.equal(result.status, 1, result.text);
  assert.match(
    result.text,
    /^-LOGICAL_OPERATOR_KEYS \(value\): readonly \["and", "or", "not"\]$/mu,
  );
  assert.match(
    result.text,
    /move a helper that must stay private under app\/build\//u,
  );
});

test("api-diff fails when an auto-import's declared signature narrows a callback parameter (dms#463 bucketAxisFormatter timestamp)", (t) => {
  const root = frontendRepo(t);
  put(
    root,
    BUCKETS,
    BUCKETS_SOURCE.replace("timestamp?: unknown", "timestamp?: number"),
  );
  commit(root);
  const result = apiDiff(root);
  assert.equal(result.status, 1, result.text);
  assert.match(
    result.text,
    /^-bucketAxisFormatter \(value\): .*timestamp\?: unknown/mu,
  );
  assert.match(
    result.text,
    /^\+bucketAxisFormatter \(value\): .*timestamp\?: number/mu,
  );
});

test("api-diff fails when an @internal file under internal/ adds an auto-import, even with --allow-added '**/internal/**' (dms#470 createFormFields)", (t) => {
  const root = frontendRepo(t);
  put(
    root,
    `${FRONTEND}/layers/dms-ui/app/composables/form/internal/formState.ts`,
    '/** @internal @packageDocumentation */\nexport function createFormFields(names: string[]): Record<string, string> {\n  return Object.fromEntries(names.map((name) => [name, ""]));\n}\n',
  );
  commit(root);
  const result = apiDiff(root, ["--allow-added", "**/internal/**"]);
  assert.equal(result.status, 1, result.text);
  assert.match(
    result.text,
    /^\+createFormFields \(value\): \(names: string\[\]\) => Record<string, string>$/mu,
  );
  assert.match(result.text, /@internal does not hide an auto-import/u);
});

test("api-diff lists each auto-import's name and signature and passes when only unexported helpers, private app/build files or file layout change", (t) => {
  const root = frontendRepo(t);
  const unchanged = apiDiff(root);
  assert.equal(unchanged.status, 0, unchanged.text);
  assert.match(
    unchanged.text,
    /^Auto-imports: 1 packages, 6 entries unchanged against base/mu,
  );
  put(
    root,
    EVALUATOR,
    EVALUATOR_SOURCE.replace(
      "return key in rule;",
      "return Object.hasOwn(rule, key);",
    ),
  );
  put(
    root,
    `${FRONTEND}/layers/dms-core/app/build/utils/privateHelper.ts`,
    "export function privateHelper(value: number): number {\n  return value;\n}\nexport const addedPrivately = 1;\n",
  );
  rmSync(join(root, BUCKETS));
  put(
    root,
    `${FRONTEND}/layers/dms-ui/app/utils/chart/apexDatetimeBuckets.ts`,
    BUCKETS_SOURCE,
  );
  commit(root);
  const result = apiDiff(root);
  assert.equal(result.status, 0, result.text);
  assert.match(
    result.text,
    /^Auto-imports: 1 packages, 6 entries unchanged against base/mu,
  );
});

test("api-diff names the declaration form to use when registerAutoImports is not given string literals", (t) => {
  const root = frontendRepo(t);
  put(
    root,
    `${FRONTEND}/dms.frontend.build.ts`,
    'const directories = ["layers/*/app/composables"];\nexport default (build: { registerAutoImports(entries: string[]): void }) => {\n  build.registerAutoImports(directories);\n};\n',
  );
  commit(root);
  const result = apiDiff(root);
  assert.equal(result.status, 1, result.text);
  assert.match(
    result.text,
    /registerAutoImports\(\["app\/composables", \.\.\.\]\)/u,
  );
});

test("api-diff compares an auto-imported interface by its members: a reorder passes, a narrowed member fails", (t) => {
  const root = frontendRepo(t);
  const interfaceFile = `${FRONTEND}/layers/dms-core/app/types/page.ts`;
  put(
    root,
    interfaceFile,
    "export interface PageQuery {\n  page: number;\n  sort?: string | number;\n}\n",
  );
  commit(root);
  execFileSync("git", ["tag", "-f", "base"], { cwd: root });
  put(
    root,
    interfaceFile,
    "export interface PageQuery {\n  sort?: number | string;\n  page: number;\n}\n",
  );
  commit(root);
  const reordered = apiDiff(root);
  assert.equal(reordered.status, 0, reordered.text);
  put(
    root,
    interfaceFile,
    "export interface PageQuery {\n  sort?: string;\n  page: number;\n}\n",
  );
  commit(root);
  const narrowed = apiDiff(root);
  assert.equal(narrowed.status, 1, narrowed.text);
  assert.match(
    narrowed.text,
    /^\+PageQuery \(type\): \{ "page": number; "sort"\?: string \| undefined; \}$/mu,
  );
});
