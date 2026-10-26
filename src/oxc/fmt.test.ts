import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const fmtModule = new URL("./fmt.ts", import.meta.url).href;
const oxfmt = fileURLToPath(
  new URL("../bin/oxfmt", import.meta.resolve("oxfmt")),
);

test("format ignores generated roots but checks authored build and output directories", () => {
  const root = mkdtempSync(join(tmpdir(), "antelope-fmt-"));
  try {
    const write = (path: string, source: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), source);
    };
    write(
      "oxfmt.config.ts",
      `import { antelopeFmtPreset } from ${JSON.stringify(fmtModule)};\nexport default antelopeFmtPreset();\n`,
    );
    for (const path of [
      "dist/a.ts",
      "build/a.ts",
      "output/a.ts",
      ".output/a.ts",
      "src/core/build/a.ts",
      "src/core/output/a.ts",
      "test/cli/output/a.ts",
    ])
      write(path, "export  const   a = 1\n");
    const result = spawnSync(process.execPath, [oxfmt, "--list-different"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.deepEqual(result.stdout.split("\n").filter(Boolean).sort(), [
      "src/core/build/a.ts",
      "src/core/output/a.ts",
      "test/cli/output/a.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
