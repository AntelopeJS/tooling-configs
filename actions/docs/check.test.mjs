import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

import { checkDocs } from "./check.mjs";

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), "docs-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  for (const [path, text] of Object.entries(files)) write(path, text);
  return { root, write };
}

const fence = (language, code) => `\n\n\`\`\`${language}\n${code}\n\`\`\`\n`;

it("accepts monorepo links, encoded paths, references, HTML, and heading anchors", (t) => {
  const { root } = fixture(t, {
    "packages/a/README.md": `# Package
[guide][reference]
[self](#package)
[source](../b/index.ts#L1)
[folder](../b/)
[html](../b/docs/guide%20(1).md#explicit)
![image](../b/logo.svg)
<a href="../b/docs/guide%20(1).md#repeat-1">Duplicate heading</a>
<img src='../b/logo.svg'>

[reference]: <../b/docs/guide (1).md?view=1#hello-world>
`,
    "packages/b/docs/guide (1).md": `# Hello *world*
## Repeat
## Repeat
<a name="explicit"></a>
`,
    "packages/b/index.ts": "export {};",
    "packages/b/logo.svg": "<svg/>",
  });
  const result = checkDocs({
    root,
    files: ["packages/a/README.md", "packages/b/docs"],
  });
  assert.deepEqual(result.failures, []);
  assert.equal(result.links, 8);
  assert.equal(result.files, 2);
});

it("rejects missing files and anchors, including images, reference links, and HTML", (t) => {
  const { root } = fixture(t, {
    "README.md": `[file](docs/missing.md)
[anchor](docs/page.md#missing)
[reference][missing]
![image](missing.svg)
<a href="missing.html">Missing</a>
<img src="missing.png">

[missing]: docs/nope.md
`,
    "docs/page.md": "# Present",
  });
  const { failures } = checkDocs({ root, files: ["README.md"] });
  assert.equal(failures.length, 6);
  assert.match(failures.join("\n"), /missing anchor #missing/);
  for (const name of [
    "missing.md",
    "nope.md",
    "missing.svg",
    "missing.html",
    "missing.png",
  ]) {
    assert.ok(
      failures.some((failure) => failure.includes(name)),
      name,
    );
  }
});

it("does not interpret frontmatter, routes, MDC props, comments, or pseudocode as files", (t) => {
  const { root } = fixture(t, {
    "docs/page.mdc": `---
navigation:
  title: '[not a link](missing.md)'
---
# Page
[route](/docs/interfaces/no-local-file#route-anchor)
[external](https://not-a-real-host.invalid/missing)
[network](//not-a-real-host.invalid/missing)
[email](mailto:person@example.com)
<a :href="dynamicValue" data-href="not-a-file">Dynamic</a>
<!-- [not rendered](missing.md) <a id="hidden"> -->
::card{to="/docs/modules/dms/reference"}
Navigation
::
\`[inline example](missing.md)\`
${fence("md", "[example](missing.md)\n<!-- docs-api: missing.ts -->")}
${fence("ts", "const incomplete: string = 42;")}
`,
  });
  const result = checkDocs({ root, files: ["docs"] });
  assert.deepEqual(result.failures, []);
  assert.equal(result.links, 0);
  assert.equal(result.examples, 0);
});

it("handles Unicode, entities, duplicate headings, setext, custom ids, and ignores code headings", (t) => {
  const { root } = fixture(t, {
    "README.md": `# Café &amp; \`Tea\`
## Repeat
## Repeat
## Repeat-1
Setext title
------------
## Custom {#stable}
<span id="html-id"></span>
[unicode](#caf%C3%A9--tea)
[duplicate](#repeat-1)
[collision](#repeat-1-1)
[setext](#setext-title)
[custom](#stable)
[html](#html-id)
${fence("md", "# Not a heading")}
[code is not a heading](#not-a-heading)
`,
  });
  const { failures } = checkDocs({ root, files: ["README.md"] });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /missing anchor #not-a-heading/);
});

const compatibility = (
  range,
  field = "peerDependencies",
  packageName = "@antelopejs/core",
) => `
<!-- docs-compat: ./package.json#${field} -->

| Package | Range |
| --- | --- |
| \`${packageName}\` | \`${range}\` |
`;

it("compares labeled ranges semantically and rejects narrowed, widened, and absent declarations", (t) => {
  const { root, write } = fixture(t, {
    "package.json": JSON.stringify({
      peerDependencies: { "@antelopejs/core": "^1.2.0" },
    }),
  });
  for (const range of ["^1.2.0", ">=1.2.0 <2.0.0", ">=1.2.0   <2"]) {
    write("README.md", compatibility(range));
    assert.deepEqual(
      checkDocs({ root, files: ["README.md"] }).failures,
      [],
      range,
    );
  }
  for (const range of [
    "^1.3.0",
    ">=1.0.0 <2",
    "^2.0.0",
    ">=1.2.0-beta <2",
    "",
  ]) {
    write("README.md", compatibility(range));
    const { failures } = checkDocs({ root, files: ["README.md"] });
    assert.equal(failures.length, 1, range);
    assert.match(failures[0], /compatibility drift/);
  }
  write("README.md", compatibility("^1.2.0", "dependencies"));
  assert.equal(checkDocs({ root, files: ["README.md"] }).failures.length, 1);
  write("README.md", compatibility("^1.2.0", "peerDependencies", "missing"));
  assert.equal(checkDocs({ root, files: ["README.md"] }).failures.length, 1);
  write(
    "package.json",
    JSON.stringify({
      peerDependencies: { "@antelopejs/core": ">=1.2.0-beta <1.2.0" },
    }),
  );
  write("README.md", compatibility(">=1.2.0-beta <1.2.0-0"));
  assert.equal(checkDocs({ root, files: ["README.md"] }).failures.length, 1);
  write("README.md", compatibility(">=1.2.0-beta <1.2.0"));
  assert.deepEqual(checkDocs({ root, files: ["README.md"] }).failures, []);
});

it("checks only labeled rows, accepts matching workspace specs, and fails malformed labels", (t) => {
  const { root, write } = fixture(t, {
    "package.json": JSON.stringify({
      dependencies: { "@antelopejs/core": "workspace:*" },
    }),
    "README.md":
      compatibility("workspace:*", "dependencies") +
      `
| Package | Range |
| --- | --- |
| imaginary | ^99.0.0 |
`,
  });
  assert.deepEqual(checkDocs({ root, files: ["README.md"] }).failures, []);
  write("README.md", compatibility("workspace:^", "dependencies"));
  assert.equal(checkDocs({ root, files: ["README.md"] }).failures.length, 1);
  write(
    "README.md",
    "<!-- docs-compat: ./package.json#peerDependencies -->\n\nMissing table",
  );
  assert.match(
    checkDocs({ root, files: ["README.md"] }).failures[0],
    /needs.*table/,
  );
});

function typescriptFixture(t, text) {
  const setup = fixture(t, {
    "README.md": text,
    "package.json": '{"type":"module"}',
    "src/value.ts":
      "export const answer: number = 42; export type Answer = number;",
    "src/index.ts": 'export { answer, type Answer } from "./value.js";',
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        module: "NodeNext",
        target: "ES2022",
        types: [],
        skipLibCheck: true,
        // Build configs can skip checking; the docs guardrail must not.
        noCheck: true,
      },
      include: ["src/**/*.ts"],
    }),
  });
  mkdirSync(join(setup.root, "node_modules"));
  const require = createRequire(import.meta.url);
  symlinkSync(
    dirname(require.resolve("typescript/package.json")),
    join(setup.root, "node_modules/typescript"),
    "dir",
  );
  return setup;
}

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

it("requires the project for annotations and isolates complete examples", (t) => {
  const { root, write } = typescriptFixture(
    t,
    fence("ts docs-check", "const value: string = 'ok';") +
      fence("typescript docs-check", "const value: number = 123;"),
  );
  assert.match(
    checkDocs({ root, files: ["README.md"] }).failures[0],
    /require --typescript-project/,
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

it("rejects paths outside the checkout, missing selections, and empty selections", (t) => {
  const { root } = fixture(t, { "README.md": "[outside](../)" });
  assert.match(
    checkDocs({ root, files: ["README.md"] }).failures[0],
    /escapes consumer checkout/,
  );
  assert.throws(() => checkDocs({ root, files: ["missing"] }), /ENOENT/);
  assert.throws(() => checkDocs({ root, files: [] }), /no Markdown/);
});

it("exposes actionable CLI exit codes for newline-separated action inputs", (t) => {
  const { root, write } = fixture(t, {
    "README.md": "[docs](docs/page.md)",
    "docs/page.md": "# Page",
  });
  const run = () =>
    spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./check.mjs", import.meta.url)),
        "--files",
        "README.md\ndocs",
        "--typescript-project",
        "",
      ],
      { cwd: root, encoding: "utf8" },
    );
  const success = run();
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /2 files, 1 local links/);
  write("docs/page.md", "[broken](missing.md)");
  const failure = run();
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /broken local link missing.md/);
});
