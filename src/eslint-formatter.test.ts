import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";

import { antelopeNuxtConfig } from "./eslint.ts";
import { scratchFiles } from "./helpers/scratch-files.ts";

const oxfmt = fileURLToPath(
  new URL("../bin/oxfmt", import.meta.resolve("oxfmt")),
);

const SOURCES = {
  "Field.vue": `<script setup lang="ts">
const mask = 0X0F;
</script>

<template>
  <label><input type="text" :maxlength="mask"><br/></label>
  <section><span /></section>
</template>
`,
  "ids.ts": "export const mask = 0X0F;\n",
};

test("ESLint --fix keeps what oxfmt writes for void elements and hex literals: fails one that leaves vue/html-self-closing at void never or unicorn/number-literal-case on", async () => {
  const project = scratchFiles(SOURCES);
  try {
    const files = project.names;
    const format = spawnSync(process.execPath, [oxfmt, ...files], {
      cwd: project.root,
      encoding: "utf8",
    });
    assert.equal(format.status, 0, format.stderr);
    const formatted = files.map(project.read);
    const eslint = new ESLint({
      cwd: project.root,
      fix: true,
      overrideConfigFile: true,
      overrideConfig: await antelopeNuxtConfig(),
    });
    const results = await eslint.lintFiles(files);
    await ESLint.outputFixes(results);
    assert.deepEqual(
      results.flatMap((result) => result.messages.map((m) => m.ruleId)),
      [],
    );
    assert.deepEqual(files.map(project.read), formatted);
    const check = spawnSync(process.execPath, [oxfmt, "--check", ...files], {
      cwd: project.root,
      encoding: "utf8",
    });
    assert.equal(check.status, 0, check.stdout);
  } finally {
    project.remove();
  }
});

test("vue/html-self-closing still reports an empty component the formatter leaves open: fails one that turns the rule off instead of aligning it", async () => {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: await antelopeNuxtConfig(),
  });
  const [result] = await eslint.lintText(
    "<template>\n  <MyCard></MyCard>\n</template>\n",
    { filePath: "Card.vue" },
  );
  assert.deepEqual(
    result?.messages.map((message) => message.ruleId),
    ["vue/html-self-closing"],
  );
});
