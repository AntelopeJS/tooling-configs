import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ESLint } from "eslint";

import { antelopeNuxtConfig } from "./eslint.ts";
import { lintProject } from "./oxc/helpers/lint-project.ts";

const FORMATTERS = `export function describe(value: unknown): string {
  return String(value);
}
export function describeObject(value: object): string {
  return String(value);
}
export function describeDefined(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}
export function describeRecord(value: { name: string }): string {
  return String(value);
}
`;

test("oxlint no-base-to-string skips an unknown, also once narrowed past null and undefined, and still reports declared object types", () => {
  const project = lintProject(true);
  try {
    project.write("format.ts", FORMATTERS);
    const { diagnostics } = project.run();
    assert.deepEqual(
      diagnostics
        .filter(
          (diagnostic: { code: string }) =>
            diagnostic.code === "typescript(no-base-to-string)",
        )
        .map(
          (diagnostic: {
            filename: string;
            labels: { span: { line: number } }[];
          }) => `${diagnostic.filename}:${diagnostic.labels[0]?.span.line}`,
        ),
      ["format.ts:5", "format.ts:12"],
    );
  } finally {
    project.remove();
  }
});

test("the .vue no-base-to-string skips an unknown, also once narrowed past null and undefined, and still reports declared object types", async () => {
  const root = mkdtempSync(join(tmpdir(), "antelope-eslint-"));
  const cwd = process.cwd();
  try {
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, module: "esnext" },
        include: ["*.vue"],
      }),
    );
    writeFileSync(
      join(root, "Format.vue"),
      `<script setup lang="ts">\n${FORMATTERS.replaceAll("export ", "")}</script>\n\n<template><div>{{ describe(1) }}{{ describeObject({}) }}</div></template>\n`,
    );
    process.chdir(root);
    const config = antelopeNuxtConfig({ typeAware: { tsconfigRootDir: root } });
    process.chdir(cwd);
    const eslint = new ESLint({
      cwd: root,
      overrideConfigFile: true,
      overrideConfig: await config,
    });
    const [result] = await eslint.lintFiles(["Format.vue"]);
    assert.deepEqual(
      result?.messages
        .filter(
          (message) =>
            message.ruleId === "@typescript-eslint/no-base-to-string",
        )
        .map((message) => message.line),
      [6, 13],
    );
  } finally {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
});
