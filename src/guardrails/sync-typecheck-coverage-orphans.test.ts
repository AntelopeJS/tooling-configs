import assert from "node:assert/strict";
import test from "node:test";

import { findingsFor } from "./helpers/coverage-repo.ts";

const ROOT = '{ "include": ["src"] }';
const TYPECHECK = { typecheck: "tsc --noEmit" };

function orphan(file: string): string {
  return `${file}: no script or workflow typechecks this project. Add \`tsc --noEmit -p ${file}\` to "typecheck", or delete the file.`;
}

function orphans(errors: readonly string[]): string[] {
  return errors.filter((error) => error.includes("no script or workflow"));
}

test("a tracked tsconfig that sets include, files or references and that no run reads fails, naming the file and the fix; a check without the rule passes all three", (t) => {
  assert.deepEqual(
    orphans(
      findingsFor(t, TYPECHECK, {
        "tsconfig.json": ROOT,
        "tests/tsconfig.json": '{ "include": ["."] }',
        "tsconfig.templates.json": '{ "files": ["templates/a.ts"] }',
        "tsconfig.solution.json": '{ "references": [{ "path": "./tests" }] }',
      }),
    ),
    [
      orphan("tests/tsconfig.json"),
      orphan("tsconfig.solution.json"),
      orphan("tsconfig.templates.json"),
    ],
  );
});

test("a tsconfig that defines no program, or sits under node_modules, .agents or a git-ignored tree, is left alone; a check that scans every tsconfig file fails these", (t) => {
  assert.deepEqual(
    orphans(
      findingsFor(t, TYPECHECK, {
        "tsconfig.json": ROOT,
        "tsconfig.base.json": '{ "compilerOptions": { "strict": true } }',
        "packages/a/node_modules/x/tsconfig.json": ROOT,
        ".agents/skills/s/tsconfig.json": ROOT,
        ".gitignore": ".nuxt\n",
        ".nuxt/tsconfig.json": ROOT,
      }),
    ),
    [],
  );
});

test("each reader counts: -p in any script, vue-tsc, tsc -b with its references, a file a read one extends, and a launcher by path; a check that reads only the typecheck script's tsc -p reports each", (t) => {
  assert.deepEqual(
    orphans(
      findingsFor(
        t,
        {
          ...TYPECHECK,
          "typecheck:tests": "vue-tsc --noEmit -p tests/tsconfig.json",
          "build:lib": "tsc -b lib",
          "check:scripts":
            "node scripts/node_modules/typescript/bin/tsc.js -p scripts",
        },
        {
          "tsconfig.json": '{ "extends": "./tsconfig.shared.json" }',
          "tsconfig.shared.json": ROOT,
          "tests/tsconfig.json": ROOT,
          "lib/tsconfig.json": '{ "references": [{ "path": "../core" }] }',
          "core/tsconfig.json": ROOT,
          "scripts/tsconfig.json": ROOT,
        },
      ),
    ),
    [],
  );
});

test("a workspace member's script reads its -p from the member's directory, and a cd or -C moves it; a check that resolves every path from the root reports these", (t) => {
  assert.deepEqual(
    orphans(
      findingsFor(
        t,
        {
          ...TYPECHECK,
          "typecheck:app": "cd apps/web && tsc --noEmit -p tsconfig.app.json",
          "typecheck:docs": "pnpm -C apps/docs exec tsc --noEmit",
        },
        {
          "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
          "tsconfig.json": ROOT,
          "packages/a/package.json": JSON.stringify({
            name: "a",
            scripts: { typecheck: "tsc --noEmit -p tsconfig.test.json" },
          }),
          "packages/a/tsconfig.test.json": ROOT,
          "apps/web/tsconfig.app.json": ROOT,
          "apps/docs/tsconfig.json": ROOT,
        },
      ),
    ),
    [],
  );
});

test("a workflow step reads its -p from its working-directory; a check that reads only package.json reports it, and one that ignores working-directory reports the second", (t) => {
  assert.deepEqual(
    orphans(
      findingsFor(t, TYPECHECK, {
        "tsconfig.json": ROOT,
        "e2e/tsconfig.json": ROOT,
        "site/tsconfig.json": ROOT,
        ".github/workflows/types.yml": [
          "jobs:",
          "  types:",
          "    steps:",
          "      - run: pnpm exec tsc --noEmit -p e2e",
          "      - run: npx vue-tsc --noEmit",
          "        working-directory: site",
        ].join("\n"),
      }),
    ),
    [],
  );
});

test("a script that reads one tsconfig does not cover its sibling; a check that counts a whole directory once any file in it is read passes the orphan", (t) => {
  assert.deepEqual(
    orphans(
      findingsFor(t, TYPECHECK, {
        "tsconfig.json": ROOT,
        "tsconfig.tests.json": ROOT,
        "tests/tsconfig.json": ROOT,
      }),
    ),
    [orphan("tests/tsconfig.json"), orphan("tsconfig.tests.json")],
  );
});

test("a tsconfig a script or a workflow names as a word counts, as the projects of a wrapper script or an action input; a check that knows only tsc runs reports the three projects dms-frontend checks that way", (t) => {
  assert.deepEqual(
    orphans(
      findingsFor(
        t,
        {
          typecheck:
            "tsc --noEmit && tsx scripts/typecheck-projects.ts tsconfig.templates.json scripts/tsconfig.json",
        },
        {
          "tsconfig.json": ROOT,
          "tsconfig.templates.json": ROOT,
          "scripts/tsconfig.json": ROOT,
          "docs/tsconfig.json": ROOT,
          ".github/workflows/docs.yml": [
            "jobs:",
            "  docs:",
            "    uses: AntelopeJS/tooling-configs/.github/workflows/docs.yml@v0",
            "    with:",
            "      docs-typescript-project: docs/tsconfig.json",
          ].join("\n"),
        },
      ),
    ),
    [],
  );
});
