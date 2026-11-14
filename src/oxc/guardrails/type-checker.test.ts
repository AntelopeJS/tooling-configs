import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ts from "@typescript/typescript6";

import { typedFile } from "./type-checker.ts";

const SCRIPT = 'const a: string = "x";\nvoid a;';

const COMPONENTS = {
  tsx: `<script setup lang="tsx">${SCRIPT}</script>\n`,
  ts: `<script setup lang="ts" >${SCRIPT}</script>\n`,
};

test("a component whose script switches between lang tsx and lang ts in one process, with the same script view, is typed as JSX, then as TypeScript, then as JSX again (fails if the parse cache keeps one kind per path and throws when it changes, or a cached program is reused for the same text in another kind)", () => {
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
