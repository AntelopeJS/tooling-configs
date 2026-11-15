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

const SITES = ["a", "b", "c"];

const SITE_COMPONENT =
  '<script setup lang="ts">\nimport type { Shared } from "#shared";\nconst value: Shared = { a: "x" };\nvoid value;\n</script>\n';

test("a file that the programs of tsconfigs in different directories, each declaring its own `paths`, all read is parsed once for all of them, as in a monorepo whose Nuxt sites each generate a tsconfig over shared layers and packages (fails if the parse cache keys a file by the directory that declares `paths`, so the heap holds one copy of every shared file per site and runs out as sites are added)", () => {
  const root = mkdtempSync(join(tmpdir(), "antelope-typed-file-"));
  try {
    mkdirSync(join(root, "shared"));
    writeFileSync(
      join(root, "shared/types.d.ts"),
      "export interface Shared { a: string }\n",
    );
    const shared = SITES.map((site) => {
      mkdirSync(join(root, site, "app"), { recursive: true });
      writeFileSync(
        join(root, site, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            types: [],
            paths: { "#shared": ["../shared/types.d.ts"] },
          },
          include: ["app/**/*.vue"],
        }),
      );
      const component = join(root, site, "app/X.vue");
      writeFileSync(component, SITE_COMPONENT);
      const typed = typedFile(component, SITE_COMPONENT);
      const imported = typed?.sourceFile.statements.find(
        ts.isImportDeclaration,
      );
      return (
        imported &&
        typed?.checker
          .getSymbolAtLocation(imported.moduleSpecifier)
          ?.declarations?.[0]?.getSourceFile()
      );
    });
    assert.equal(shared[0]?.fileName, join(root, "shared/types.d.ts"));
    assert.equal(new Set(shared).size, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
