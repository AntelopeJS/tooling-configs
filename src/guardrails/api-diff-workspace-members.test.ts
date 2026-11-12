import assert from "node:assert/strict";
import test from "node:test";

import { apiRepo, bin, commit, put } from "./helpers/test-repo.ts";

const WORKSPACES = {
  "a pnpm workspace listing other packages": "packages:\n  - frontend-vue\n",
  "a pnpm workspace listing no packages": "allowBuilds:\n  lefthook: false\n",
};

for (const [layout, workspace] of Object.entries(WORKSPACES))
  test(`api-diff skips a public playground outside ${layout} and proves the root`, (t) => {
    const root = apiRepo(t);
    put(root, "pnpm-workspace.yaml", workspace);
    put(root, "src/index.ts", "export const answer = 42;\n");
    put(
      root,
      "playground/package.json",
      JSON.stringify({
        name: "playground",
        main: "dist/index.js",
        scripts: { build: "exit 1" },
      }),
    );
    put(
      root,
      "playground/tsconfig.json",
      JSON.stringify({ compilerOptions: { outDir: "dist", noEmit: true } }),
    );
    put(root, "playground/src/index.ts", "export const app = 1;\n");
    commit(root);
    const result = bin(root, "api-diff", ["HEAD"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(
      result.stdout,
      /API: skipped playground, not a workspace package\./,
    );
    assert.match(result.stdout, /Runtime API: 1 packages, 1 entries unchanged/);
  });
