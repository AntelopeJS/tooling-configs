import assert from "node:assert/strict";
import test from "node:test";

import { revisionCounts } from "./revisions.ts";
import {
  countSuppressions,
  suppressionsIn,
  worktreeSuppressions,
} from "./suppressions.ts";
import { commit, put, testRepo } from "./helpers/test-repo.ts";

const EXPORT_JOBS_RUN = [
  "export function emptyContext<TContext>(): TContext {",
  "  return (",
  "    (null as unknown as TContext) // oxlint-disable-line anti-slop/no-chained-type-assertions -- the export-job helpers never read a null context",
  "  );",
  "}",
  "",
].join("\n");

test("a directive written after code on the same line is counted, in the proof table too", (t) => {
  assert.deepEqual(
    suppressionsIn(
      "packages/dms/src/utils/export-jobs-run.ts",
      EXPORT_JOBS_RUN,
    ),
    [
      {
        kind: "rule",
        rule: "anti-slop/no-chained-type-assertions",
        directive: "oxlint-disable-line",
        reason: "the export-job helpers never read a null context",
        file: "packages/dms/src/utils/export-jobs-run.ts",
        line: 3,
      },
    ],
  );
  const root = testRepo(t);
  put(root, "src/export-jobs-run.ts", "export const empty = null;\n");
  commit(root);
  put(root, "src/export-jobs-run.ts", EXPORT_JOBS_RUN);
  commit(root);
  assert.match(
    revisionCounts(root, "HEAD~1"),
    /\| Lint suppressions, `anti-slop\/no-chained-type-assertions` \| 0 \| 1 \|/,
  );
});

test("each lint directive counts once per rule it names, and under * when it names none", () => {
  const text = [
    "/* eslint-disable @typescript-eslint/no-invalid-void-type -- void permits callers to omit return */",
    "export type PageSetupFunction = () => void;",
    "export function layout() {",
    "  // Partial doubles: the layout resolver only reads a member's role ids and",
    "  // oxlint-disable anti-slop/no-chained-type-assertions",
    "  return {} as unknown as never;",
    "}",
    '// oxlint-disable-next-line import/no-self-import, import/no-cycle -- test seam: calls go through `self.` so `sinon.stub(module, "fn")` takes effect',
    'import * as self from "./config-loader";',
    "// oxlint-disable-next-line -- no rule named",
    "debugger;",
    "",
  ].join("\n");
  assert.deepEqual(
    suppressionsIn("page-setup.ts", text).map(({ line, ...entry }) => [
      line,
      "rule" in entry ? entry.rule : entry.kind,
    ]),
    [
      [1, "@typescript-eslint/no-invalid-void-type"],
      [5, "anti-slop/no-chained-type-assertions"],
      [8, "import/no-self-import"],
      [8, "import/no-cycle"],
      [10, "*"],
    ],
  );
});

test("strings and template literals that contain directive text count nothing", () => {
  const text = [
    "const expected =",
    "  '<h1 class=\"text-highlighted text-2xl\"><!--[-->Explorer<!--]--></h1><!--v-if--></div><!--[--><!--[--><!-- eslint-disable vue/no-v-html --><!--v-if--><!--]--><!--]--></section>' +",
    '  "// oxlint-disable-next-line eslint/max-params" +',
    "  `/* @ts-expect-error ${'// SAFETY: not a comment'} */ // @ts-ignore`;",
    "const pattern = /\\/\\/ oxlint-disable-line eslint\\/max-params/u;",
    "",
  ].join("\n");
  assert.deepEqual(suppressionsIn("page-fill-height.test.ts", text), []);
});

test("type directives and SAFETY: comments count wherever they sit", () => {
  const text = [
    "const MEMBER = {",
    '  name: "Member",',
    "  // @ts-expect-error the free-form { type, options } is no display",
    '  display: { type: "identity", options: {} },',
    "};",
    "// SAFETY: Menu access reads only the user's id and optional owner flag.",
    'const OWNER = { _id: "nested-menu-owner" } as User;',
    "const legacy = load(); /* @ts-ignore */ // SAFETY: legacy loader",
    "",
  ].join("\n");
  assert.deepEqual(countSuppressions(suppressionsIn("menu.test.ts", text)), {
    rules: {},
    tsExpectError: 1,
    tsIgnore: 1,
    safety: 2,
    config: {},
  });
});

test("Vue template comments and script directives count at their own line", () => {
  const text = [
    '<script setup lang="ts">',
    "const markup = '<!-- eslint-disable vue/no-v-html -->';",
    "// oxlint-disable-next-line typescript/no-misused-spread",
    "const copy = { ...markup };",
    "</script>",
    "",
    "<template>",
    "  <!-- eslint-disable vue/no-v-html -->",
    '  <div v-if="showsServerMarkup" v-html="serverMarkup" />',
    "  <!-- eslint-disable-next-line vue/no-v-html -->",
    '  <div v-else v-html="sanitizedHtml" />',
    "</template>",
    "",
    "<style>",
    "/* eslint-disable vue/no-v-html */",
    "</style>",
    "",
  ].join("\n");
  assert.deepEqual(
    suppressionsIn("PageHeaderActionsOutlet.vue", text).map(({ line }) => line),
    [3, 8, 10],
  );
});

test("generated output is left out the way the size guard leaves it out", (t) => {
  const root = testRepo(t);
  const directive = "// oxlint-disable-next-line eslint/max-params\n";
  put(root, "dist/index.js", directive);
  put(root, "src/i18n-registry.generated.ts", directive);
  put(root, "packages/app/package.json", "{}\n");
  put(root, "packages/app/build/bundle.js", directive);
  put(root, "src/build/authored.ts", directive);
  put(root, "README.md", directive);
  commit(root);
  assert.deepEqual(
    worktreeSuppressions(root).map(({ file }) => file),
    ["src/build/authored.ts"],
  );
});

test("a comment counts as SAFETY: exactly when the type assertion rule accepts it, once per comment", () => {
  const text = [
    "// invariant. SAFETY: x",
    "export const a = value as string;",
    "/**",
    " * Reads the row.",
    " * SAFETY: y",
    " */",
    "export const b = value as number;",
    "// SAFETY: one comment, SAFETY: counted once",
    'export const c = "SAFETY: only text" as string;',
    "// SAFETYNET: not a marker",
    "// SAFETY:",
    "",
  ].join("\n");
  assert.deepEqual(
    suppressionsIn("rows.ts", text).map(({ kind, line }) => [kind, line]),
    [
      ["safety", 1],
      ["safety", 3],
      ["safety", 8],
    ],
  );
});
