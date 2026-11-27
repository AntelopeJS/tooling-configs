import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { parseDocument } from "yaml";

import { affectedTestsFit } from "./affected-tests.ts";
import {
  CI_CALLER,
  CI_NODE_REF,
  ciProfile,
  ciWorkflow,
} from "./ci-workflow.ts";
import { ciNodeCallers, ciRenovateSyncCallers } from "./workflow.ts";

/** A repository: the `test` script of each package by directory, `""` the root, and the pnpm workspace globs. */
interface Layout {
  packages: Record<string, string | undefined>;
  workspace?: string[];
  names?: Record<string, string>;
}

function repo(t: TestContext, layout: Layout): string {
  const root = mkdtempSync(join(tmpdir(), "antelope-affected-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [directory, script] of Object.entries(layout.packages)) {
    mkdirSync(join(root, directory), { recursive: true });
    const manifest = {
      name:
        new Map(Object.entries(layout.names ?? {})).get(directory) ??
        (directory || "workspace"),
      scripts: script === undefined ? {} : { test: script },
    };
    writeFileSync(
      join(root, directory, "package.json"),
      JSON.stringify(manifest),
    );
  }
  if (layout.workspace)
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      `packages:\n${layout.workspace.map((glob) => `  - "${glob}"\n`).join("")}`,
    );
  return root;
}

const FITTING = {
  "interface-core": {
    packages: {
      "": "pnpm run build && mocha 'dist/tests/**/*.test.js' && node test/package-consumer.mjs",
    },
  },
  "a single package listing only itself": {
    packages: { "": "pnpm run build && scripts/test.sh" },
    workspace: ["./"],
  },
  "cloud-sdk": {
    packages: {
      "": "pnpm -r --workspace-concurrency=1 run test && node --test scripts/*.test.mjs",
      sdk: "vitest run",
      cli: "vitest run",
    },
    workspace: ["sdk", "cli"],
  },
  "dms-automation, whose package test runs its frontend's": {
    packages: {
      "": "pnpm --dir packages/dms-automation test",
      "packages/dms-automation":
        "pnpm run build && node --test tests/*.test.cjs && pnpm --dir frontend-vue test",
      "packages/dms-automation/frontend-vue": "node --test tests/*.test.cjs",
      "packages/interface-dms-automation": undefined,
    },
    workspace: ["packages/*", "packages/*/frontend-vue"],
  },
  "a root that filters packages by name": {
    packages: {
      "": "pnpm --filter @scope/a --filter ./b test",
      a: "vitest run",
      b: "vitest run",
    },
    workspace: ["a", "b"],
    names: { a: "@scope/a" },
  },
} satisfies Record<string, Layout>;

const MISFITTING = {
  "dms-saas, whose root runs check:exports while dms-saas tests more": {
    packages: {
      "": "pnpm --filter @antelopejs/interface-dms-saas check:exports",
      "packages/dms-saas":
        "pnpm run build && pnpm --filter @antelopejs/interface-dms-saas run check:exports && pnpm run test:unit",
      "packages/interface-dms-saas": undefined,
    },
    workspace: ["packages/dms-saas", "packages/interface-dms-saas"],
    names: { "packages/interface-dms-saas": "@antelopejs/interface-dms-saas" },
  },
  "dms-mailing, whose root runs test:layer while the package test also runs test:backend":
    {
      packages: {
        "": "pnpm --dir packages/dms-mailing test:layer",
        "packages/dms-mailing": "pnpm run test:backend && pnpm run test:layer",
        "packages/dms-mailing/frontend-vue": "vitest run",
      },
      workspace: ["packages/*", "packages/*/frontend-vue"],
    },
  "dms, whose root picks tests with its own selector": {
    packages: { "": "node checks/run-tests.mjs", "packages/dms": "vitest run" },
    workspace: ["packages/*"],
  },
  "agent-skills, whose tests sit at the root": {
    packages: {
      "": 'node --test "test/*.test.mjs"',
      "plugin/packages/agent-skills": undefined,
    },
    workspace: ["plugin/packages/*"],
  },
  "antelope-web, whose tests sit at the root": {
    packages: {
      "": "node --test tools/docs-nav.test.mjs",
      "layers/base": undefined,
    },
    workspace: ["layers/*", "sites/*"],
  },
  "dms-media, whose root runs the frontend's tests but not the module's": {
    packages: {
      "": "pnpm --dir packages/dms-media/frontend-vue test",
      "packages/dms-media": "ajs module test .",
      "packages/dms-media/frontend-vue": "vitest run",
    },
    workspace: ["packages/dms-media", "packages/dms-media/frontend-vue"],
  },
  "a recursive run that a filter narrows to one of two tested packages": {
    packages: {
      "": "pnpm -r --filter a run test",
      a: "vitest run",
      b: "vitest run",
    },
    workspace: ["a", "b"],
  },
  "a module with a playground, whose root tests may use it": {
    packages: {
      "": "pnpm run build && ajs module test .",
      playground: undefined,
    },
    workspace: ["./", "playground"],
  },
} satisfies Record<string, Layout>;

test("a single package and a workspace whose package test scripts make up the suite fit affected-tests, so a detection that leaves them running every test fails", (t) => {
  for (const [name, layout] of Object.entries(FITTING))
    assert.equal(affectedTestsFit(repo(t, layout)), true, name);
});

test("a workspace whose suite is not its package test scripts misfits affected-tests, so a detection that would skip or add tests on its pull requests fails", (t) => {
  for (const [name, layout] of Object.entries(MISFITTING))
    assert.equal(affectedTestsFit(repo(t, layout)), false, name);
});

function inputs(text: string): Record<string, boolean | string> | undefined {
  return parseDocument(text).toJS().jobs.ci.with;
}

function rewrite(text: string, affectedTests: boolean): string {
  return ciWorkflow(text, ciNodeCallers(text), ciRenovateSyncCallers(text), {
    affectedTests,
    profile: ciProfile("@antelopejs-private/cloud"),
  }).content;
}

test("a fitting repository gets affected-tests: true on a new or existing caller, once, so a sync that never writes it or reports it as drift fails", () => {
  const written = ciWorkflow(undefined, [], [], {
    affectedTests: true,
  }).content;
  assert.equal(inputs(written)?.["affected-tests"], true);
  const bare = `jobs:\n  ci:\n    uses: ${CI_NODE_REF}\n`;
  const once = rewrite(bare, true);
  assert.equal(inputs(once)?.["affected-tests"], true);
  assert.equal(rewrite(once, true), once);
  assert.match(once, /branches: \[develop\]/);
});

test("a misfitting repository gets no affected-tests input and keeps one it set, so a sync that writes it everywhere or erases a hand-set value fails", () => {
  assert.equal(
    ciWorkflow(undefined, [], [], { affectedTests: false }).content,
    ciWorkflow(undefined, [], [], {}).content,
  );
  assert.equal(
    inputs(ciWorkflow(undefined, [], [], {}).content)?.["affected-tests"],
    undefined,
  );
  const own = CI_CALLER.replace(
    "test-job: true",
    "test-job: true\n      affected-tests: true",
  );
  assert.equal(
    ciWorkflow(own, ciNodeCallers(own), ciRenovateSyncCallers(own), {}).content,
    own,
  );
});
