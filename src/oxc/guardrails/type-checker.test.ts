import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ts from "@typescript/typescript6";

import { typedFile } from "./type-checker.ts";

const COMPONENTS = {
  tsx: '<script setup lang="tsx">const a = <div title="x" />;\nvoid a;</script>\n',
  ts: '<script setup lang="ts">const a: string = "x";\nvoid a;</script>\n',
};

test("a component edited between lang tsx and lang ts in one process is typed as JSX, then as TypeScript, then as JSX again (fails if the parse cache keeps one kind per path and throws when it changes, or keeps the earlier kind)", () => {
  const root = mkdtempSync(join(tmpdir(), "antelope-typed-file-"));
  try {
    mkdirSync(join(root, "app"));
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, jsx: "preserve", types: [] },
        include: ["app/**/*.vue"],
      }),
    );
    const component = join(root, "app/X.vue");
    const variants = [COMPONENTS.tsx, COMPONENTS.ts, COMPONENTS.tsx].map(
      (text) => {
        writeFileSync(component, text);
        return typedFile(component, text)?.sourceFile.languageVariant;
      },
    );
    assert.deepEqual(variants, [
      ts.LanguageVariant.JSX,
      ts.LanguageVariant.Standard,
      ts.LanguageVariant.JSX,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
