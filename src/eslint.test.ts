import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ESLint } from "eslint";

import { antelopeNuxtConfig } from "./eslint.ts";

test("Nuxt resolves every warning severity to error while preserving options and off", async () => {
  const configs = await antelopeNuxtConfig({
    rules: {
      "no-console": "warn",
      "no-debugger": 1,
      eqeqeq: ["warn", "always", { null: "ignore" }],
      curly: [1, "multi-line"],
      "no-alert": "off",
      "no-empty": [0, { allowEmptyCatch: true }],
    },
  }).append(
    { name: "global-ignores", ignores: ["cache/**"] },
    {
      rules: {
        "no-console": "warn",
        "no-debugger": 1,
        eqeqeq: ["warn", "always", { null: "ignore" }],
        curly: [1, "multi-line"],
        "no-alert": "off",
        "no-empty": [0, { allowEmptyCatch: true }],
        "no-var": "warn",
      },
    },
  );
  const rules = Object.assign({}, ...configs.map((config) => config.rules));
  assert.equal(rules["no-console"], "error");
  assert.equal(rules["no-debugger"], "error");
  assert.deepEqual(rules.eqeqeq, ["error", "always", { null: "ignore" }]);
  assert.deepEqual(rules.curly, ["error", "multi-line"]);
  assert.equal(rules["no-var"], "error");
  assert.equal(rules["no-alert"], "off");
  assert.deepEqual(rules["no-empty"], [0, { allowEmptyCatch: true }]);
  const globalIgnores = configs.find(
    (config) => config.name === "global-ignores",
  );
  assert(globalIgnores);
  assert(
    !("rules" in globalIgnores),
    "An ignores-only config must keep global ignore semantics",
  );
  for (const config of configs) {
    for (const rule of Object.values(config.rules ?? {})) {
      const severity = Array.isArray(rule) ? rule[0] : rule;
      assert.notEqual(severity, "warn");
      assert.notEqual(severity, 1);
    }
  }
});

async function lintVueProject(typeAware: boolean) {
  const root = mkdtempSync(join(tmpdir(), "antelope-eslint-"));
  const cwd = process.cwd();
  try {
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          module: "esnext",
          moduleResolution: "bundler",
        },
        include: ["*.ts", "*.vue"],
      }),
    );
    writeFileSync(
      join(root, "load.ts"),
      "export async function load(): Promise<number> {\n  return 1;\n}\nload();\n",
    );
    writeFileSync(
      join(root, "Subject.vue"),
      '<script setup lang="ts">\nimport { load } from "./load";\nconst parsed: number = JSON.parse("1");\nload();\n</script>\n\n<template><div>{{ parsed }}</div></template>\n',
    );
    if (typeAware) process.chdir(root);
    const config = antelopeNuxtConfig(
      typeAware ? { typeAware: { tsconfigRootDir: root } } : {},
    );
    process.chdir(cwd);
    const eslint = new ESLint({
      cwd: root,
      overrideConfigFile: true,
      overrideConfig: await config,
    });
    const results = await eslint.lintFiles(["load.ts", "Subject.vue"]);
    return results.flatMap((result) =>
      result.messages.map(
        (message) =>
          `${result.filePath.slice(root.length + 1)}:${message.line} ${message.ruleId ?? message.message}`,
      ),
    );
  } finally {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
}

test("typeAware runs the type-aware rules on .vue script blocks with types from sibling files, from a directory without typescript, and leaves .ts files to oxlint", async () => {
  assert.deepEqual(await lintVueProject(true), [
    "Subject.vue:3 @typescript-eslint/no-unsafe-assignment",
    "Subject.vue:4 @typescript-eslint/no-floating-promises",
  ]);
});

test("without typeAware no rule needs type information", async () => {
  assert.deepEqual(await lintVueProject(false), []);
});

async function lintComposable(
  config: ReturnType<typeof antelopeNuxtConfig>,
): Promise<string[]> {
  const eslint = new ESLint({
    cwd: process.cwd(),
    overrideConfigFile: true,
    overrideConfig: await config,
  });
  const [result] = await eslint.lintText(
    'import { ref } from "vue";\n\nconst open = ref(false);\n\nexport function useOpen(): number {\n  let count = 0;\n  count = 1;\n  if (open) return count;\n  return 1;\n  useOpen();\n}\n',
    { filePath: join(process.cwd(), "composables/useOpen.ts") },
  );
  assert(result);
  return result.messages.map(
    (message) => `${message.line} ${message.ruleId ?? message.message}`,
  );
}

test("a .ts composable gets no-unreachable and the Vue script rules and keeps the core rules the Vue block turns off", async () => {
  assert.deepEqual(await lintComposable(antelopeNuxtConfig()), [
    "6 no-useless-assignment",
    "8 vue/no-ref-as-operand",
    "10 no-unreachable",
  ]);
});

test("a layer's appended rules still win over the Vue script rules in .ts files", async () => {
  assert.deepEqual(
    await lintComposable(
      antelopeNuxtConfig().append({
        rules: { "vue/no-ref-as-operand": "off" },
      }),
    ),
    ["6 no-useless-assignment", "10 no-unreachable"],
  );
});
