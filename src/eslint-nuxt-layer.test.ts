import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";

import { ESLint } from "eslint";

import { antelopeNuxtConfig } from "./eslint.ts";

const COMPILER_OPTIONS = {
  strict: true,
  module: "esnext",
  moduleResolution: "bundler",
};

const USER_MODULE = `export interface User {
  name: string;
}

export async function loadUser(): Promise<User> {
  return { name: "ada" };
}
`;

/** The aliased import is on line 6, the floating call on line 10 and the `Object.assign` of an `unknown` on line 11. */
const PROFILE = `<template>
  <div>{{ user.name }}</div>
</template>

<script setup lang="ts">
import { loadUser, type User } from "#dms-core/user";

const user: User = { name: "ada" };
const parsed: unknown = JSON.parse("1");
loadUser();
Object.assign(user, { name: parsed });
</script>
`;

/** Lints `targets` of a layer whose files are `files`, as the `eslint` CLI does from the layer's root. */
async function lintLayer(
  files: Record<string, string>,
  targets = ["app/Profile.vue"],
): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), "antelope-nuxt-layer-"));
  const cwd = process.cwd();
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    process.chdir(root);
    const config = antelopeNuxtConfig({ typeAware: { tsconfigRootDir: root } });
    process.chdir(cwd);
    const eslint = new ESLint({
      cwd: root,
      overrideConfigFile: true,
      overrideConfig: await config,
    });
    const results = await eslint.lintFiles(targets);
    return results.flatMap((result) =>
      result.messages.map(
        (message) =>
          `${relative(root, result.filePath).replaceAll("\\", "/")}:${message.line} ${message.ruleId ?? message.message}`,
      ),
    );
  } finally {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
}

test("a layer tsconfig that extends the generated .nuxt/tsconfig.json types an aliased import in a .vue file, so no-floating-promises sees the Promise and no-unsafe-object-assign checks the write (fails if the Vue script is left out of the TypeScript program, or the alias stays unresolved)", async () => {
  assert.deepEqual(
    await lintLayer({
      ".nuxt/tsconfig.json": JSON.stringify({
        compilerOptions: {
          ...COMPILER_OPTIONS,
          paths: { "#dms-core/*": ["../core/*"] },
        },
        include: ["../**/*"],
      }),
      "tsconfig.json": JSON.stringify({ extends: "./.nuxt/tsconfig.json" }),
      "core/user.ts": USER_MODULE,
      "app/Profile.vue": PROFILE,
    }),
    [
      "app/Profile.vue:10 @typescript-eslint/no-floating-promises",
      "app/Profile.vue:11 antelopejs/no-unsafe-object-assign",
    ],
  );
});

test("a layer tsconfig without the alias reports the import as unresolved, in a generic component too, and types nothing through it, so no-floating-promises stays silent (fails if an import the program cannot resolve goes unreported)", async () => {
  const findings = await lintLayer(
    {
      "tsconfig.json": JSON.stringify({
        compilerOptions: COMPILER_OPTIONS,
        include: ["**/*"],
      }),
      "core/user.ts": USER_MODULE,
      "app/Profile.vue": PROFILE,
      "app/Generic.vue": PROFILE.replace(
        '<script setup lang="ts">',
        '<script setup lang="ts" generic="T">',
      ),
    },
    ["app/Profile.vue", "app/Generic.vue"],
  );
  assert.deepEqual(
    findings.filter((finding) =>
      /require-tsconfig-include|no-floating-promises/u.test(finding),
    ),
    [
      "app/Profile.vue:6 antelopejs/require-tsconfig-include",
      "app/Generic.vue:6 antelopejs/require-tsconfig-include",
    ],
  );
});

const LABEL = `<template>
  <p>{{ props.title }}</p>
</template>

<script setup lang="ts">
interface Props { title: string }
const props: Props = { title: "" };
</script>
`;

const TALLY = `<template>
  <p>{{ state.title }}</p>
</template>

<script setup lang="ts">
interface Props { title: number }
const state: Props = { title: 0 };
const next: number = 1;
Object.assign(state, { title: next });
</script>
`;

const PICK = `<template>
  <p>{{ picked.name }}</p>
</template>

<script setup lang="ts" generic="T extends { name: string }">
import { box } from "./box";

const item = box<T>();
const picked: { name: string } = { name: "" };
Object.assign(picked, { name: item.value.name });
</script>
`;

test("components without imports keep their declarations apart, and no-unsafe-object-assign skips a generic component, so neither yields a guardrail finding (fails if a component is read as a global script, or a `generic` type parameter is an error type)", async () => {
  const findings = await lintLayer(
    {
      "tsconfig.json": JSON.stringify({
        compilerOptions: { ...COMPILER_OPTIONS, moduleDetection: "force" },
        include: ["**/*"],
      }),
      "app/Label.vue": LABEL,
      "app/Tally.vue": TALLY,
      "app/box.ts": "export declare function box<V>(): { value: V };\n",
      "app/Pick.vue": PICK,
    },
    ["app/Label.vue", "app/Tally.vue", "app/Pick.vue"],
  );
  assert.deepEqual(
    findings.filter((finding) => finding.includes("antelopejs/")),
    [],
  );
});

/** Vue's global `defineProps`, as `@vue/runtime-core` declares it. */
const VUE_MACROS = `declare global {
  function defineProps<T>(): Readonly<T>;
}
export {};
`;

/** dms's LayoutContainer.vue: a component without imports whose `props` sorts first in the program, which reads it as raw text. */
const CONTAINER = `<script setup lang="ts">
const props = defineProps<{ wide: boolean }>();
</script>

<template>
  <div :class="{ wide: props.wide }" />
</template>
`;

/** dms-automation's LiveTopics.vue without the `toRef` import it needed: the loop on line 10 hands each topic to a `string` parameter. */
const LIVE_TOPICS = `<script setup lang="ts">
const props = defineProps<{
  realtimeTopic: string[];
}>();

function listen(topic: string): string {
  return topic;
}

for (const topic of props.realtimeTopic) listen(topic);
</script>

<template>
  <span hidden />
</template>
`;

/** A layer whose two components import nothing, read under `moduleDetection`. */
function macroLayer(moduleDetection: "auto" | "force") {
  return {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { ...COMPILER_OPTIONS, moduleDetection },
      include: ["**/*"],
    }),
    "app/env.d.ts": VUE_MACROS,
    "app/components/LayoutContainer.vue": CONTAINER,
    "app/components/LiveTopics.vue": LIVE_TOPICS,
    "app/components/Spacer.vue":
      '<script setup lang="ts">\ndefineProps<{ size: number }>();\n</script>\n\n<template>\n  <hr />\n</template>\n',
  };
}

test("a defineProps component without imports lints clean when its tsconfig reads every file as a module, as the generated .nuxt/tsconfig.json does, and require-tsconfig-include names the missing moduleDetection otherwise (fails if the script's `props` resolves to another component's global declaration, or a tsconfig that makes it a global script goes unreported, or a script that declares no name is reported)", async () => {
  const targets = [
    "app/components/LiveTopics.vue",
    "app/components/Spacer.vue",
  ];
  assert.deepEqual(await lintLayer(macroLayer("force"), targets), []);
  assert.deepEqual(
    (await lintLayer(macroLayer("auto"), targets)).filter((finding) =>
      finding.includes("antelopejs/"),
    ),
    ["app/components/LiveTopics.vue:1 antelopejs/require-tsconfig-include"],
  );
});
