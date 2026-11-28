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

test("a run step without its own working-directory starts in its job's or workflow's defaults.run.working-directory; a check that reads only the step's key reports both projects", (t) => {
  assert.deepEqual(
    orphans(
      findingsFor(t, TYPECHECK, {
        "tsconfig.json": ROOT,
        "web/tsconfig.json": ROOT,
        "web/tests/tsconfig.json": ROOT,
        "api/tsconfig.json": ROOT,
        ".github/workflows/types.yml": [
          "defaults:",
          "  run:",
          "    working-directory: api",
          "jobs:",
          "  web:",
          "    defaults:",
          "      run:",
          "        working-directory: web",
          "    steps:",
          "      - run: |",
          "          npx vue-tsc --noEmit",
          "          npx vue-tsc --noEmit -p tests",
          "  api:",
          "    steps:",
          "      - run: npx tsc --noEmit",
        ].join("\n"),
      }),
    ),
    [],
  );
});

test("a run step in another working-directory does not read the root project, and a paths filter naming a tsconfig reads nothing; a check that also reads every workflow string from the root passes both orphans", (t) => {
  assert.deepEqual(
    orphans(
      findingsFor(
        t,
        { lint: "oxlint" },
        {
          "tsconfig.json": ROOT,
          "site/tsconfig.json": ROOT,
          "tools/tsconfig.json": ROOT,
          ".github/workflows/types.yml": [
            "on:",
            "  push:",
            "    paths: [tools/tsconfig.json]",
            "jobs:",
            "  site:",
            "    steps:",
            "      - run: npx tsc --noEmit",
            "        working-directory: site",
          ].join("\n"),
        },
      ),
    ),
    [orphan("tools/tsconfig.json"), orphan("tsconfig.json")],
  );
});

test("a cd inside a subshell does not move the runs after it, and a script run with -C in a package outside the workspace is read; a check that keeps the cd or reads only workspace members reports the root and the nested projects", (t) => {
  assert.deepEqual(
    orphans(
      findingsFor(
        t,
        {
          typecheck:
            "(cd web && vue-tsc --noEmit) && tsc --noEmit && pnpm -C app run typecheck",
        },
        {
          "tsconfig.json": ROOT,
          "web/tsconfig.json": ROOT,
          "app/package.json": JSON.stringify({
            name: "app",
            scripts: { typecheck: "vue-tsc --noEmit -p tsconfig.app.json" },
          }),
          "app/tsconfig.app.json": ROOT,
        },
      ),
    ),
    [],
  );
});

test("a run step of a composite action counts, and a launcher path ending in .mjs, .cjs or .ts is a tsc run; a check that reads only workflows or strips only .js reports these", (t) => {
  assert.deepEqual(
    orphans(
      findingsFor(
        t,
        {
          "typecheck:a": "node bin/tsc.mjs --noEmit",
          "typecheck:b": "node bin/tsc.cjs -b b",
          "typecheck:c": "node src/bin/tsc.ts --noEmit -p c",
        },
        {
          "tsconfig.json": ROOT,
          "b/tsconfig.json": ROOT,
          "c/tsconfig.json": ROOT,
          "e2e/tsconfig.json": ROOT,
          ".github/actions/types/action.yml": [
            "runs:",
            "  using: composite",
            "  steps:",
            "    - run: npx tsc --noEmit",
            "      shell: bash",
            "      working-directory: e2e",
          ].join("\n"),
        },
      ),
    ),
    [],
  );
});
