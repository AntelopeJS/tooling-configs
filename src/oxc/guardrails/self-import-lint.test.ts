import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { lintProject } from "../helpers/lint-project.ts";

const MANIFEST = JSON.stringify({
  name: "@antelopejs/interface-demo",
  exports: { ".": "./dist/index.js" },
});
const SELF_IMPORT = `import { run } from "@antelopejs/interface-demo";\nexport const value = run;\n`;

function selfImports(result: {
  diagnostics: { code: string; filename: string }[];
}) {
  return result.diagnostics
    .filter(({ code }) => code === "antelopejs(no-self-import-in-tests)")
    .map(({ filename }) => filename);
}

test("the preset flags a self-import in a test file and not in source or in a linked package", () => {
  const project = lintProject();
  try {
    project.write("package.json", MANIFEST);
    project.write("src/index.ts", "export const run = 1;\n");
    project.write("src/tests/index.test.ts", SELF_IMPORT);
    project.write("src/uses-self.ts", SELF_IMPORT);
    assert.deepEqual(selfImports(project.run(true)), [
      "src/tests/index.test.ts",
    ]);
    mkdirSync(join(project.root, "node_modules/@antelopejs"), {
      recursive: true,
    });
    symlinkSync(
      project.root,
      join(project.root, "node_modules/@antelopejs/interface-demo"),
      "dir",
    );
    assert.deepEqual(selfImports(project.run(true)), []);
  } finally {
    project.remove();
  }
});
