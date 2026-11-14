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
