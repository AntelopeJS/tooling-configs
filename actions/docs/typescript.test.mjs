import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";

import { checkDocs } from "./check.mjs";
import { fence, fixture, typescriptFixture } from "./fixtures.mjs";

it("checks annotated examples with consumer import resolution without executing them", (t) => {
  const { root, write } = typescriptFixture(
    t,
    fence(
      "ts docs-check",
      `import { answer } from "./src/index.js";
const result: number = answer;
throw new Error("must never execute");`,
    ),
  );
  const check = () =>
    checkDocs({ root, files: ["README.md"], project: "tsconfig.json" });
  assert.deepEqual(check().failures, []);
  assert.equal(check().examples, 1);
  write(
    "README.md",
    fence(
      "ts docs-check",
      'import { answer } from "./src/index.js";\nconst result: string = answer;',
    ),
  );
  assert.match(check().failures.join("\n"), /TS2322/);
  write(
    "README.md",
    fence("ts docs-check", 'import { absent } from "./src/index.js";'),
  );
  assert.match(check().failures.join("\n"), /TS2305/);
  write("README.md", fence("ts", "this is deliberately incomplete pseudocode"));
  assert.match(check().failures.join("\n"), /README\.md:4: TS\d+/);
  write(
    "README.md",
    fence("ts fragment", "this is deliberately incomplete pseudocode"),
  );
  assert.deepEqual(check().failures, []);
});

it("checks TSX props using the consumer's JSX settings", (t) => {
  const { root, write } = typescriptFixture(t, "");
  write(
    "tsxconfig.json",
    JSON.stringify({
      extends: "./tsconfig.json",
      compilerOptions: { jsx: "preserve" },
    }),
  );
  const check = () =>
    checkDocs({ root, files: ["README.md"], project: "tsxconfig.json" });
  write(
    "README.md",
    fence(
      "tsx docs-check",
      "declare function Widget(props: { count: number }): null;\n<Widget count={42} />;",
    ),
  );
  assert.deepEqual(check().failures, []);
  write(
    "README.md",
    fence(
      "tsx docs-check",
      'declare function Widget(props: { count: number }): null;\n<Widget count="wrong" />;',
    ),
  );
  assert.match(check().failures.join("\n"), /TS2322/);
});

it("isolates complete examples", (t) => {
  const { root, write } = typescriptFixture(
    t,
    fence("ts docs-check", "const value: string = 'ok';") +
      fence("typescript docs-check", "const value: number = 123;"),
  );
  const result = checkDocs({
    root,
    files: ["README.md"],
    project: "tsconfig.json",
  });
  assert.deepEqual(result.failures, []);
  assert.equal(result.examples, 2);
  write(
    "docs/tsconfig.json",
    JSON.stringify({
      compilerOptions: { strict: true, types: [] },
      include: ["*.ts"],
    }),
  );
  assert.deepEqual(
    checkDocs({ root, files: ["README.md"], project: "docs/tsconfig.json" })
      .failures,
    [],
  );
});

it("compares API headings with actual named and type re-exports, detecting missing and stale names", (t) => {
  const declaration = "<!-- docs-api: ./src/index.ts -->\n\n";
  const { root, write } = typescriptFixture(
    t,
    `${declaration}## \`answer\`\n\n## \`Answer\`\n`,
  );
  const check = () =>
    checkDocs({ root, files: ["README.md"], project: "tsconfig.json" });
  assert.deepEqual(check().failures, []);
  write("README.md", `${declaration}## \`answer\`\n\n## \`Removed\`\n`);
  const { failures } = check();
  assert.equal(failures.length, 2);
  assert.ok(
    failures.some((failure) =>
      failure.includes("missing API heading for export Answer"),
    ),
  );
  assert.ok(
    failures.some((failure) =>
      failure.includes("API heading Removed is not exported"),
    ),
  );
  write("src/index.ts", 'export * from "./value.js"; export default 1;');
  write(
    "README.md",
    `${declaration}## \`answer\`\n\n## \`Answer\`\n\n## \`default\`\n`,
  );
  assert.deepEqual(check().failures, []);
});

const lineOf = (text, needle) =>
  text.slice(0, text.indexOf(needle)).split("\n").length;

it("typechecks every TypeScript fence unless its info string carries fragment", (t) => {
  const text = `---
title: Usage
---
# Usage

Prose before the examples.
${fence("ts [src/example.ts]", 'import { answer } from "./src/index.js";\nconst result: number = answer;')}
${fence("typescript", "const first = 1;\nconst wrong: string = first;")}
${fence("ts fragment", "pseudo code that never compiles")}
${fence("ts [src/label.ts] fragment", "more pseudo code")}
${fence("tsx fragment [Widget.tsx]", "<Broken")}
${fence("mts", "export const mts: number = 'text';")}
${fence("cts", "export const cts: number = 1;")}
${fence("ts docs-check", "export const legacy: number = 1;")}
${fence("bash", "not typescript at all")}
${fence("js", "const notChecked: = ;")}
- A list item

  ${"```"}ts
  const nested: number = "nested";
  ${"```"}
`;
  const { root } = typescriptFixture(t, text);
  const result = checkDocs({
    root,
    files: ["README.md"],
    project: "tsconfig.json",
  });
  assert.equal(result.examples, 6);
  assert.deepEqual(
    result.failures.map((failure) =>
      failure.split(": ").slice(0, 2).join(": "),
    ),
    [
      `README.md:${lineOf(text, "const wrong")}: TS2322`,
      `README.md:${lineOf(text, "export const mts")}: TS2322`,
      `README.md:${lineOf(text, "const nested")}: TS2322`,
    ],
  );
});

it("resolves the repo's own package names to workspace source, not stale or missing builds", (t) => {
  const exported = (types) => ({
    types,
    default: types.replace(/\.d\.ts$/, ".js"),
  });
  const example = `import { answer } from "@acme/root";
import { extra } from "@acme/root/extra";
import { b } from "@acme/b";
import { c } from "@acme/c";
import { d } from "@acme/d";
const total: number = answer + extra + b + c + d;`;
  const { root, write } = typescriptFixture(
    t,
    fence("ts docs-check", example),
    {
      "package.json": JSON.stringify({
        name: "@acme/root",
        type: "module",
        workspaces: ["tools/*"],
        exports: {
          ".": exported("./dist/index.d.ts"),
          "./package.json": "./package.json",
          "./internal/*": null,
          "./*": exported("./dist/*.d.ts"),
        },
      }),
      "src/extra.ts": "export const extra: number = 1;",
      "dist/index.d.ts": "export declare const answer: string;",
      "dist/extra.d.ts": "export declare const stale: string;",
      "pnpm-workspace.yaml": `packages:
  # every package
  - "packages/*"
  - '!packages/ignored'

onlyBuiltDependencies:
  - esbuild
`,
      "packages/b/package.json": JSON.stringify({
        name: "@acme/b",
        type: "module",
        exports: { ".": exported("./build/index.d.ts") },
      }),
      "packages/b/tsconfig.json": JSON.stringify({
        compilerOptions: { outDir: "build", rootDir: "lib" },
      }),
      "packages/b/lib/index.ts": "export const b: number = 2;",
      "packages/c/package.json": JSON.stringify({
        name: "@acme/c",
        type: "module",
        exports: {
          ".": { source: "./source/main.ts", types: "./dist/index.d.ts" },
        },
      }),
      "packages/c/source/main.ts": "export const c: number = 3;",
      "packages/ignored/package.json": JSON.stringify({
        name: "@acme/ignored",
        main: "dist/index.js",
      }),
      "packages/ignored/src/index.ts": "export const ignored = 1;",
      "tools/d/package.json": JSON.stringify({
        name: "@acme/d",
        main: "dist/index.js",
      }),
      "tools/d/src/index.ts": "export const d: number = 4;",
    },
  );
  mkdirSync(join(root, "node_modules/@acme"));
  symlinkSync(
    join(root, "packages/b"),
    join(root, "node_modules/@acme/b"),
    "dir",
  );
  const check = () =>
    checkDocs({ root, files: ["README.md"], project: "tsconfig.json" });
  assert.deepEqual(check().failures, []);
  write(
    "README.md",
    fence(
      "ts",
      'import { answer } from "@acme/root";\nconst text: string = answer;',
    ) + fence("ts", 'import { ignored } from "@acme/ignored";\nignored;'),
  );
  const failures = check().failures.join("\n");
  assert.match(failures, /README\.md:5: TS2322/);
  assert.match(failures, /README\.md:10: TS2307/);
});

it("defaults to the root tsconfig and names the input when there is none", (t) => {
  const { root, write } = typescriptFixture(
    t,
    fence("ts", "const wrong: string = 1;"),
  );
  const check = () => checkDocs({ root, files: ["README.md"] });
  assert.match(check().failures.join("\n"), /README\.md:4: TS2322/);
  rmSync(join(root, "tsconfig.json"));
  const [missing, ...rest] = check().failures;
  assert.deepEqual(rest, []);
  assert.match(missing, /typescript-project/);
  assert.match(missing, /fragment/);
  write("README.md", fence("ts fragment", "pseudo") + fence("bash", "ls"));
  assert.deepEqual(check().failures, []);
  assert.equal(check().examples, 0);
});

it("overrides compiler options that break virtual example roots", (t) => {
  const { root } = typescriptFixture(t, fence("ts", "export const ok = 1;"), {
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        module: "NodeNext",
        types: [],
        rootDir: "src",
        outDir: "dist",
        composite: true,
        incremental: true,
        tsBuildInfoFile: "dist/.tsbuildinfo",
      },
      include: ["src/**/*.ts"],
    }),
  });
  const result = checkDocs({ root, files: ["README.md"] });
  assert.deepEqual(result.failures, []);
  assert.equal(result.examples, 1);
});

it("reports a TypeScript that does not resolve as a fix instead of crashing", (t) => {
  const { root } = fixture(t, {
    "README.md": fence("ts", "export const ok = 1;"),
    "tsconfig.json": "{}",
  });
  const { failures } = checkDocs({ root, files: ["README.md"] });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /tsconfig\.json: .*install/);
});
