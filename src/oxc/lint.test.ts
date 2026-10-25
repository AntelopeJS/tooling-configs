import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { lintProject } from "./helpers/lint-project.ts";

test("recorded rules override all preset layers and test overrides; measurement restores debt", () => {
  const project = lintProject();
  try {
    project.write(
      "debt.test.ts",
      `
// Ordinary comment
export function excessive(a, b, c, d, e, f) { return [a, b, c, d, e, f]; }
export function untyped(value: object) { return value; }
it("has no assertions", () => { excessive(1, 2, 3, 4, 5, 6); });
it("restates a constant", () => { expect(MAX_ITEMS).toBe(5); });
`,
    );
    project.write(
      "guardrails.ratchet.json",
      JSON.stringify({
        rules: {
          "eslint/max-params": 1,
          "anti-slop/no-object-parameters": 1,
          "antelopejs/no-comments": 1,
          "antelopejs/no-constant-value-assertion": 1,
          "antelopejs/require-assertion": 1,
        },
        oversizeFiles: {},
      }),
    );
    const measured = project.run(true);
    const codes = measured.diagnostics.map(
      (diagnostic: { code: string }) => diagnostic.code,
    );
    for (const code of [
      "eslint(max-params)",
      "anti-slop(no-object-parameters)",
      "antelopejs(no-comments)",
      "antelopejs(no-constant-value-assertion)",
      "antelopejs(require-assertion)",
    ]) {
      assert(codes.includes(code), JSON.stringify(measured));
    }
    assert.notEqual(measured.status, 0);
    const normal = project.run();
    assert.equal(normal.status, 0, JSON.stringify(normal));
    assert.deepEqual(normal.diagnostics, []);
    assert.equal(
      project.run("").diagnostics.length,
      measured.diagnostics.length,
    );
  } finally {
    project.remove();
  }
});

test("an oversize exemption turns off max-lines only for its recorded path", () => {
  const project = lintProject();
  try {
    const source = Array.from(
      { length: 505 },
      (_, i) => `export const item${i} = ${i};`,
    ).join("\n");
    project.write("large[legacy].ts", source);
    project.write("largel.ts", source);
    project.write(
      "guardrails.ratchet.json",
      JSON.stringify({
        rules: {},
        oversizeFiles: { "large[legacy].ts": 40_000 },
      }),
    );
    const normal = project.run();
    const maxLines = normal.diagnostics.filter(
      (diagnostic: { code: string }) => diagnostic.code === "eslint(max-lines)",
    );
    assert.equal(maxLines.length, 1, JSON.stringify(normal));
    assert.equal(maxLines[0].filename, "largel.ts");
    const measured = project.run(true);
    assert.equal(
      measured.diagnostics.filter(
        (diagnostic: { code: string }) =>
          diagnostic.code === "eslint(max-lines)",
      ).length,
      2,
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
    const result = project.run(true);
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
    const result = project.run(true);
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

test("ceilings come from the nearest git ancestor, including worktrees, with cwd fallback", () => {
  for (const marker of [".git/HEAD", ".git", "nested/.git", null]) {
    const project = lintProject();
    try {
      if (marker !== null) project.write(marker, "gitdir: /unused\n");
      if (marker === "nested/.git")
        project.write(".git/HEAD", "ref: refs/heads/main\n");
      project.write(
        "nested/test/foo.ts",
        "// ordinary comment\nexport const value = 1;",
      );
      project.write(
        "guardrails.ratchet.json",
        JSON.stringify({ rules: { "antelopejs/no-comments": 1 } }),
      );
      const result = project.run(false, join(project.root, "nested"));
      const comments = result.diagnostics.filter(
        (diagnostic: { code: string }) =>
          diagnostic.code === "antelopejs(no-comments)",
      );
      assert.equal(
        comments.length,
        marker === null || marker === "nested/.git" ? 1 : 0,
        JSON.stringify(result),
      );
    } finally {
      project.remove();
    }
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
    const result = project.run(true);
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
