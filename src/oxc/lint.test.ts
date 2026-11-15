import assert from "node:assert/strict";
import { test } from "node:test";

import { lintProject } from "./helpers/lint-project.ts";

test("generated roots are ignored but authored build and output directories are linted", () => {
  const project = lintProject();
  try {
    project.write(
      "oxlint.config.ts",
      `
import { ANTELOPE_IGNORE_PATTERNS } from ${JSON.stringify(new URL("./lint.ts", import.meta.url).href)};
export default {
  ignorePatterns: ANTELOPE_IGNORE_PATTERNS,
  rules: { "eslint/max-params": ["error", { max: 1 }] },
};
`,
    );
    const source = "export function many(a, b) { return [a, b]; }\n";
    for (const path of [
      "dist/a.ts",
      "build/a.ts",
      "output/a.ts",
      ".output/a.ts",
      "src/core/build/a.ts",
      "src/core/output/a.ts",
      "test/cli/output/a.ts",
    ])
      project.write(path, source);
    const result = project.run();
    assert.deepEqual(
      result.diagnostics
        .map((diagnostic: { filename: string }) => diagnostic.filename)
        .sort(),
      ["src/core/build/a.ts", "src/core/output/a.ts", "test/cli/output/a.ts"],
      JSON.stringify(result),
    );
  } finally {
    project.remove();
  }
});

test("test globs require assertions without framework imports or filename suffixes", () => {
  const project = lintProject();
  try {
    const empty = 'it("missing", () => { run(); });';
    for (const path of ["a.test.ts", "b.spec.js", "__tests__/a.ts"])
      project.write(path, empty);
    for (const path of ["test/foo.ts", "tests/a.ts"])
      project.write(path, empty);
    project.write("source.ts", empty);
    project.write(
      "valid.test.ts",
      `
it("chai", () => { expect(1).to.equal(1); });
it("node", () => { assert.equal(1, 1); });
it("helper", () => { expectFailure(run); });
it("helper", () => { assertRetryable(run()); });
it("helper", () => { expectRejection(run); });
it("sinon", () => { sinon.assert.calledOnce(spy); });
it("supertest", () => { return request(app).get("/").expect(200); });
it("should", () => { response.should.equal(200); });
it("should call", () => { should(response).equal(200); });
it("parameterized", () => {
  if (flag) expect(fn()).toBe(1);
  else expect(fn()).toBe(2);
});
export function assertionHelper() { expect(1, "a Chai or Vitest message").to.equal(1); }
`,
    );
    const result = project.run();
    const missing = result.diagnostics.filter(
      (diagnostic: { code: string }) =>
        diagnostic.code === "antelopejs(require-assertion)",
    );
    assert.deepEqual(
      missing
        .map((diagnostic: { filename: string }) => diagnostic.filename)
        .sort(),
      ["__tests__/a.ts", "a.test.ts", "b.spec.js", "test/foo.ts", "tests/a.ts"],
      JSON.stringify(result),
    );
    assert.equal(
      result.diagnostics.filter((diagnostic: { code: string }) =>
        diagnostic.code.startsWith("jest("),
      ).length,
      0,
    );
    assert(
      !missing.some(
        (diagnostic: { filename: string }) =>
          diagnostic.filename === "source.ts",
      ),
    );
  } finally {
    project.remove();
  }
});

test("antelopejs@b0c06d3:test/core/cli/git-operations.test.ts:9 has no assertion", () => {
  const project = lintProject();
  try {
    project.write(
      "git-operations.test.ts",
      `it("exposes the git helper functions", async () => {
    await Promise.all([
      Promise.resolve(copyTemplate),
      Promise.resolve(loadManifestFromGit),
      Promise.resolve(loadInterfaceFromGit),
      Promise.resolve(loadInterfacesFromGit),
    ]);
  });`,
    );
    const result = project.run();
    assert.equal(
      result.diagnostics.filter(
        (diagnostic: { code: string }) =>
          diagnostic.code === "antelopejs(require-assertion)",
      ).length,
      1,
    );
  } finally {
    project.remove();
  }
});

test("fixture, helper and locale directories can read files while tests and ordinary source differ", () => {
  const project = lintProject();
  try {
    const source =
      'import { readFileSync } from "node:fs"; export const text = readFileSync("fixture.json", "utf8");';
    for (const path of [
      "a.test.ts",
      "test/fixtures/a.ts",
      "tests/helpers/a.ts",
      "__tests__/locales/a.ts",
      "source.ts",
    ])
      project.write(path, source);
    const result = project.run();
    const reads = result.diagnostics.filter(
      (diagnostic: { code: string }) =>
        diagnostic.code === "antelopejs(no-fs-read-in-tests)",
    );
    assert.equal(reads.length, 1, JSON.stringify(result));
    assert.equal(reads[0].filename, "a.test.ts");
  } finally {
    project.remove();
  }
});

test("the preset bans @ts-ignore but keeps @ts-expect-error with a reason", () => {
  const project = lintProject();
  try {
    project.write(
      "src/legacy.ts",
      "// @ts-ignore\nexport const ignored: number = 'x';\n// @ts-expect-error a legacy string id\nexport const expected: number = 'y';\n",
    );
    const result = project.run();
    assert.deepEqual(
      result.diagnostics.map(
        (diagnostic: {
          code: string;
          labels: { span: { line: number } }[];
        }) => [diagnostic.code, diagnostic.labels[0].span.line],
      ),
      [
        ["typescript(ban-ts-comment)", 1],
        ["antelopejs(no-comments)", 1],
      ],
      JSON.stringify(result),
    );
  } finally {
    project.remove();
  }
});
