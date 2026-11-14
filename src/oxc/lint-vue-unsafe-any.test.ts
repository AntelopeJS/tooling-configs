import assert from "node:assert/strict";
import { test } from "node:test";

import { lintProject } from "./helpers/lint-project.ts";

const tsconfig = JSON.stringify({
  compilerOptions: {
    strict: true,
    module: "esnext",
    moduleResolution: "bundler",
    types: [],
  },
  include: ["app/**/*.vue", "src/**/*.ts"],
});

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

function findings(files: Record<string, string>): string[] {
  const project = lintProject(true);
  try {
    for (const [path, source] of Object.entries(files))
      project.write(path, source);
    return project
      .run()
      .diagnostics.filter(
        (diagnostic: { code: string; filename: string }) =>
          diagnostic.code.includes("no-unsafe-") &&
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
