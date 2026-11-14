import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { bin, put, testRepo } from "./helpers/test-repo.ts";

/** Every step but `readme:version`, so it alone decides the run. */
const OTHER_STEPS =
  "typecheck,lint,format:check,knip,test,size,suppressions,sync:check,git:identity";

function moduleRepo(t: TestContext, version: string, readme: string): string {
  const root = testRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({ name: "@antelopejs/brevo", version, type: "module" }),
  );
  put(root, "README.md", readme);
  return root;
}

function example(range: string, name = "@antelopejs/brevo"): string {
  return `# Brevo\n\n\`\`\`ts\nexport default defineConfig({\n  modules: {\n    brevo: {\n      source: {\n        type: "package",\n        package: "${name}",\n        version: "${range}",\n      },\n      config: { apiKey: "" },\n    },\n  },\n});\n\`\`\`\n`;
}

function checks(root: string) {
  return bin(root, "checks", ["--no-services"], {
    ANTELOPEJS_CHECKS_SKIP: OTHER_STEPS,
  });
}

test("a README example range that no longer admits the package.json version fails checks and names its line, caught by an implementation that never compares the two", (t) => {
  const root = moduleRepo(t, "0.0.9", example("^0.0.6"));
  const result = checks(root);
  assert.equal(result.status, 1, result.stdout);
  assert.equal(
    result.stdout,
    '[readme:version]\nREADME.md:10 gives @antelopejs/brevo the version range "^0.0.6", which does not admit 0.0.9, the version in package.json. Set a range that admits it.\nChecks: 0 passed, 1 failed, 9 skipped.\n',
  );
});

test("a README example range that admits the package.json version passes, caught by an implementation that demands the exact version", (t) => {
  const root = moduleRepo(t, "0.0.10", example(">=0.0.9 <0.1.0"));
  const result = checks(root);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "Checks: 1 passed, 0 failed, 9 skipped.\n");
});

test("an npm hyphen range that admits the package.json version passes, caught by an implementation that splits a range on whitespace", (t) => {
  const root = moduleRepo(t, "0.0.7", example("0.0.6 - 0.0.9"));
  const result = checks(root);
  assert.equal(result.status, 0, result.stdout);
});

test("a stale x-range fails, caught by an implementation that reads a partial version as admitting everything", (t) => {
  const root = moduleRepo(t, "0.1.0", example("0.0.x"));
  const result = checks(root);
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /the version range "0\.0\.x", which does not admit 0\.1\.0/,
  );
});

test("a key that only ends in version is not read as the range, caught by an implementation that matches version after a hyphen", (t) => {
  const root = moduleRepo(
    t,
    "0.0.9",
    'source: { "api-version": "^9.0.0", package: "@antelopejs/brevo", version: "^0.0.9" }\n',
  );
  const result = checks(root);
  assert.equal(result.status, 0, result.stdout);
});

test("a workspace package whose README range no longer admits its version fails checks run at the root, caught by an implementation that reads only the root README and package.json", (t) => {
  const root = testRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({ name: "dms-saas-workspace", private: true }),
  );
  put(root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  put(
    root,
    "packages/dms-saas/package.json",
    JSON.stringify({ name: "@antelopejs/brevo", version: "0.10.0" }),
  );
  put(root, "README.md", example("^0.9.0"));
  put(root, "packages/dms-saas/README.md", example("^0.9.0"));
  const result = checks(root);
  assert.equal(result.status, 1, result.stdout);
  assert.equal(
    result.stdout,
    '[readme:version]\nREADME.md:10 gives @antelopejs/brevo the version range "^0.9.0", which does not admit 0.10.0, the version in packages/dms-saas/package.json. Set a range that admits it.\npackages/dms-saas/README.md:10 gives @antelopejs/brevo the version range "^0.9.0", which does not admit 0.10.0, the version in packages/dms-saas/package.json. Set a range that admits it.\nChecks: 0 passed, 1 failed, 9 skipped.\n',
  );
});

test("a JSON example with quoted keys is checked too, caught by an implementation that matches only unquoted keys", (t) => {
  const root = moduleRepo(
    t,
    "1.2.0",
    '```json\n{ "source": { "type": "package", "package": "@antelopejs/brevo", "version": "~1.1.0" } }\n```\n',
  );
  const result = checks(root);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /^\[readme:version\]\nREADME\.md:2 gives /);
});

test("a README example of another package does not run the step, caught by an implementation that checks every version range against package.json", (t) => {
  const root = moduleRepo(t, "0.0.9", example("^1.4.2", "@antelopejs/mongodb"));
  const result = checks(root);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "Checks: 0 passed, 0 failed, 9 skipped.\n");
});
