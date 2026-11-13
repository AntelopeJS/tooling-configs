import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ESLint } from "eslint";

import { antelopeNuxtConfig } from "./eslint.ts";

const OVERLOADS = `function pick(value: string): string;
function pick(value: number): number;
function pick(value: string | number) {
  return value;
}
interface Size { width: number }
const Size: Size = { width: pick(0) };
`;

async function lintNuxtLayer(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "antelope-eslint-"));
  try {
    for (const [name, source] of Object.entries(files)) {
      writeFileSync(join(root, name), source);
    }
    const eslint = new ESLint({
      cwd: root,
      overrideConfigFile: true,
      overrideConfig: await antelopeNuxtConfig(),
    });
    const results = await eslint.lintFiles(Object.keys(files));
    return results
      .flatMap((result) =>
        result.messages.map(
          (message) =>
            `${result.filePath.slice(root.length + 1)}:${message.line} ${message.ruleId ?? message.message}`,
        ),
      )
      .toSorted();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("base no-redeclare and no-unused-vars stay off where typescript-eslint runs and still report JavaScript", async () => {
  assert.deepEqual(
    await lintNuxtLayer({
      "overloads.ts": `${OVERLOADS}export const width = Size.width;\nconst unused = 1;\n`,
      "Overloads.vue": `<script setup lang="ts">\n${OVERLOADS}</script>\n\n<template><div>{{ Size.width }}</div></template>\n`,
      "legacy.js": "var count = 1;\nvar count = 2;\n",
    }),
    [
      "legacy.js:2 no-redeclare",
      "legacy.js:2 no-unused-vars",
      "overloads.ts:9 @typescript-eslint/no-unused-vars",
    ],
  );
});

test("template layout and a runtime prop without a default are not reported, as oxfmt owns layout", async () => {
  assert.deepEqual(
    await lintNuxtLayer({
      "Card.vue": `<script setup lang="ts">
defineProps({ label: String, icon: String });
</script>

<template>
  <section id="card" class="card" role="region" aria-label="Card" data-kind="kpi"><span>{{ label }}</span></section>
     <p>{{ icon }}</p>
</template>
`,
    }),
    [],
  );
});

test("an empty catch passes while an empty block elsewhere stays reported", async () => {
  assert.deepEqual(
    await lintNuxtLayer({
      "cleanup.ts": `export function cleanup(stop: () => void, ready: boolean): void {
  try {
    stop();
  } catch {}
  if (ready) {
  }
}
`,
    }),
    ["cleanup.ts:5 no-empty"],
  );
});
