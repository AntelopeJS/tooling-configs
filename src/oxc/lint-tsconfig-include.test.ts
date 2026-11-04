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
