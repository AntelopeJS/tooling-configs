import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { lintProject } from "./helpers/lint-project.ts";

const typeRoot = fileURLToPath(
  new URL("..", import.meta.resolve("@types/node/package.json")),
);

const OPTIONS = { strict: true, target: "es2022", module: "nodenext" };

/** Node API calls, typed only when the file's program loads `@types/node`. */
const NODE_CALLS = `export function cwd(): string {
  return process.cwd();
}
`;

interface Diagnostic {
  code: string;
  message: string;
  filename: string;
  labels: { span: { line: number } }[];
}

function findings(diagnostics: Diagnostic[]): string[] {
  return diagnostics
    .filter(({ filename }) => filename !== "oxlint.config.ts")
    .map(
      ({ code, filename, labels }) =>
        `${filename}:${labels[0]?.span.line} ${code}`,
    )
    .sort();
}

interface Tsconfig {
  extends?: string;
  compilerOptions?: typeof OPTIONS & { typeRoots: string[] };
  include: string[];
}

function packageWith(tsconfig: Tsconfig) {
  const project = lintProject(true);
  project.write("tsconfig.json", JSON.stringify(tsconfig));
  project.write("src/index.ts", NODE_CALLS);
  return project;
}

test("a tsconfig without compilerOptions.types, where tsc loads @types/node and type-aware lint loads none, is reported on each file it lists, naming the packages to list (file-storage-local)", (t) => {
  const project = packageWith({
    compilerOptions: { ...OPTIONS, typeRoots: [typeRoot] },
    include: ["src"],
  });
  t.after(project.remove);
  const diagnostics: Diagnostic[] = project.run(true).diagnostics;
  assert.deepEqual(findings(diagnostics), [
    "src/index.ts:1 antelopejs(require-tsconfig-types)",
    "src/index.ts:2 typescript(no-unsafe-return)",
  ]);
  const report = diagnostics.find(
    ({ code }) => code === "antelopejs(require-tsconfig-types)",
  );
  assert.match(report?.message ?? "", /"types": \[[^\]]*"node"/u);
});

test("compilerOptions.types inherited through extends clears the report and types the Node calls", (t) => {
  const project = packageWith({
    extends: "./tsconfig.base.json",
    include: ["src"],
  });
  t.after(project.remove);
  project.write(
    "tsconfig.base.json",
    JSON.stringify({
      compilerOptions: { ...OPTIONS, typeRoots: [typeRoot], types: ["node"] },
    }),
  );
  assert.deepEqual(findings(project.run(true).diagnostics), []);
});

test("a tsconfig without compilerOptions.types is not reported when tsc would load no @types package either", (t) => {
  const project = packageWith({
    compilerOptions: { ...OPTIONS, typeRoots: ["./no-types"] },
    include: ["src"],
  });
  t.after(project.remove);
  project.write("no-types/README.md", "");
  project.write("src/index.ts", "export const one: number = 1;\n");
  assert.deepEqual(findings(project.run(true).diagnostics), []);
});
