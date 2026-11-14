import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { lintProject } from "./helpers/lint-project.ts";

const nodeTypes = fileURLToPath(
  new URL("..", import.meta.resolve("@types/node/package.json")),
);

const OPTIONS = {
  strict: true,
  target: "es2022",
  module: "nodenext",
  typeRoots: [nodeTypes],
  types: ["node"],
};

/** A package tsconfig with Node's types that lists `src` only, as a package that builds `src` does. */
function packageTsconfig(...include: string[]) {
  return JSON.stringify({
    compilerOptions: OPTIONS,
    include: ["src", ...include],
  });
}

/** Node API calls, typed only when the file's program loads `@types/node`. */
const NODE_CALLS = `export function cwd(): string {
  return process.cwd();
}
`;

/** antelopejs `test/package-consumer/*.cjs`, file-storage-s3 `scripts/test-uploads.mjs`: plain JavaScript run by Node. */
const NODE_SCRIPT = `export function home() {
  return process.env.HOME;
}
`;

/** A real \`any\` that every program reports. */
const REAL_ANY = `export const parsed: string = JSON.parse('"x"');
`;

interface Diagnostic {
  code: string;
  filename: string;
  labels: { span: { line: number } }[];
}

/** The findings in the files a test writes. The helper's `oxlint.config.ts` imports the preset's source, not the synced template, which `lint-synced-skills.test.ts` lints. */
function findings(diagnostics: Diagnostic[]): string[] {
  return diagnostics
    .filter(({ filename }) => filename !== "oxlint.config.ts")
    .map(
      ({ code, filename, labels }) =>
        `${filename}:${labels[0]?.span.line} ${code}`,
    )
    .sort();
}

function packageWithTests() {
  const project = lintProject(true);
  project.write("tsconfig.json", packageTsconfig());
  project.write("src/index.ts", NODE_CALLS);
  project.write("test/index.test.ts", NODE_CALLS + REAL_ANY);
  project.write("scripts/home.mjs", NODE_SCRIPT);
  project.write("tool.config.ts", NODE_CALLS);
  return project;
}

test("a file that no tsconfig includes is reported once, where type-aware lint reads it without the repository's types and reports Node calls as unsafe (antelopejs test/, file-storage-s3 scripts/)", (t) => {
  const project = packageWithTests();
  t.after(project.remove);
  assert.deepEqual(findings(project.run(true).diagnostics), [
    "scripts/home.mjs:1 antelopejs(require-tsconfig-include)",
    "scripts/home.mjs:2 typescript(no-unsafe-return)",
    "test/index.test.ts:1 antelopejs(require-tsconfig-include)",
    "test/index.test.ts:2 typescript(no-unsafe-return)",
    "test/index.test.ts:4 typescript(no-unsafe-assignment)",
    "tool.config.ts:1 antelopejs(require-tsconfig-include)",
    "tool.config.ts:2 typescript(no-unsafe-return)",
  ]);
});

test("a tsconfig.json that includes the file with the repository's options clears the report, types its Node calls and keeps its real findings", (t) => {
  const project = packageWithTests();
  t.after(project.remove);
  project.write(
    "test/tsconfig.json",
    JSON.stringify({
      extends: "../tsconfig.json",
      compilerOptions: { noEmit: true },
      include: ["."],
    }),
  );
  project.write(
    "scripts/tsconfig.json",
    JSON.stringify({
      extends: "../tsconfig.json",
      compilerOptions: { noEmit: true, allowJs: true },
      include: ["."],
    }),
  );
  project.write("tsconfig.json", packageTsconfig("tool.config.ts"));
  assert.deepEqual(findings(project.run(true).diagnostics), [
    "test/index.test.ts:4 typescript(no-unsafe-assignment)",
  ]);
});

test("a file listed by a referenced tsconfig, or by an ancestor tsconfig above a nearer one that omits it, is not reported", (t) => {
  const project = lintProject(true);
  t.after(project.remove);
  project.write(
    "tsconfig.json",
    JSON.stringify({
      files: [],
      references: [
        { path: "./tsconfig.src.json" },
        { path: "./tsconfig.test.json" },
      ],
    }),
  );
  project.write(
    "tsconfig.src.json",
    JSON.stringify({
      compilerOptions: { ...OPTIONS, composite: true },
      include: ["src"],
    }),
  );
  project.write(
    "tsconfig.test.json",
    JSON.stringify({
      compilerOptions: { ...OPTIONS, composite: true },
      include: ["test", "packages/tool/test"],
    }),
  );
  project.write(
    "packages/tool/tsconfig.json",
    JSON.stringify({ compilerOptions: OPTIONS, include: ["src"] }),
  );
  project.write("src/index.ts", NODE_CALLS);
  project.write("test/index.test.ts", NODE_CALLS);
  project.write("packages/tool/src/index.ts", NODE_CALLS);
  project.write("packages/tool/test/index.test.ts", NODE_CALLS);
  assert.deepEqual(findings(project.run(true).diagnostics), []);
});

test("only the root configs sync writes are exempt: a hand-written package config with a synced name is reported like any other unlisted file (dms-marketing packages/<pkg>/knip.config.ts)", (t) => {
  const project = lintProject(true);
  t.after(project.remove);
  project.write("tsconfig.json", packageTsconfig());
  project.write("src/index.ts", NODE_CALLS);
  project.write("knip.config.ts", "export default {};\n");
  project.write("oxfmt.config.ts", "export default {};\n");
  project.write("packages/site/knip.config.ts", "export default {};\n");
  project.write("packages/site/oxfmt.config.ts", "export default {};\n");
  assert.deepEqual(findings(project.run(true).diagnostics), [
    "packages/site/knip.config.ts:1 antelopejs(require-tsconfig-include)",
    "packages/site/oxfmt.config.ts:1 antelopejs(require-tsconfig-include)",
  ]);
});

/** Imports a tsconfig that lists only `src` cannot resolve, one per form tsc resolves. */
const UNRESOLVED_IMPORTS = `import type { Thing } from "#missing/thing";
export type { Other } from "#missing/other";
export * from "#missing/all";
export const load = () => import("#missing/lazy");
export type Alias = Thing;
`;

test("an import the tsconfig cannot resolve is reported on its module specifier, whether imported, re-exported or imported lazily, because everything imported through it is an error type", (t) => {
  const project = lintProject(true);
  t.after(project.remove);
  project.write("tsconfig.json", packageTsconfig());
  project.write("src/index.ts", UNRESOLVED_IMPORTS);
  assert.deepEqual(findings(project.run(true).diagnostics), [
    "src/index.ts:1 antelopejs(require-tsconfig-include)",
    "src/index.ts:2 antelopejs(require-tsconfig-include)",
    "src/index.ts:3 antelopejs(require-tsconfig-include)",
    "src/index.ts:4 antelopejs(require-tsconfig-include)",
  ]);
});

test("an untyped package, an ambient module, a side-effect import, a component import and an import in a JavaScript file are not reported, where no tsconfig would fix it", (t) => {
  const project = lintProject(true);
  t.after(project.remove);
  project.write("tsconfig.json", packageTsconfig());
  project.write(".gitignore", "node_modules\n");
  project.write("node_modules/untyped-pkg/index.js", "exports.value = 1;\n");
  project.write(
    "src/virtual.d.ts",
    'declare module "virtual:config" {\n  export const value: string;\n}\n',
  );
  project.write(
    "src/index.ts",
    'import * as untyped from "untyped-pkg";\nimport { value } from "virtual:config";\nimport "./missing.css";\nimport Card from "./Card.vue";\n\nexport { Card, untyped, value };\n',
  );
  project.write(
    "scripts/tsconfig.json",
    JSON.stringify({
      extends: "../tsconfig.json",
      compilerOptions: { noEmit: true, allowJs: true },
      include: ["."],
    }),
  );
  project.write("scripts/tool.mjs", 'export * from "#missing/thing";\n');
  assert.deepEqual(findings(project.run(true).diagnostics), []);
});

test("a Node built-in is unresolved under a tsconfig that loads no Node types, and resolved under one that does (fails if every built-in counts as resolved)", (t) => {
  const project = lintProject(true);
  t.after(project.remove);
  const source = 'export { readFileSync } from "node:fs";\n';
  project.write("tsconfig.json", packageTsconfig());
  project.write("src/index.ts", source);
  project.write(
    "web/tsconfig.json",
    JSON.stringify({
      compilerOptions: { ...OPTIONS, types: [] },
      include: ["."],
    }),
  );
  project.write("web/index.ts", source);
  assert.deepEqual(
    findings(project.run(true).diagnostics).filter((finding) =>
      finding.includes("require-tsconfig-include"),
    ),
    ["web/index.ts:1 antelopejs(require-tsconfig-include)"],
  );
});
