import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";

import { freePort } from "../verify/record.ts";
import { bin, binAsync, put, testRepo } from "./helpers/test-repo.ts";

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
    '[readme:version]\nREADME.md:10 gives @antelopejs/brevo the version range "^0.0.6", which does not stop below the next minor of 0.0.9, the version in package.json. Use ">=0.0.9 <0.1.0".\nChecks: 0 passed, 1 failed, 9 skipped.\n',
  );
});

test("a README example range that admits the package.json version passes, caught by an implementation that demands the exact version", (t) => {
  const root = moduleRepo(t, "0.0.10", example(">=0.0.9 <0.1.0"));
  const result = checks(root);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "Checks: 1 passed, 0 failed, 9 skipped.\n");
});

test("a range that admits the package.json version but is open past its next minor fails, caught by an implementation that only checks the range admits the version", (t) => {
  const root = moduleRepo(t, "0.0.9", example(">=0.0.9"));
  const result = checks(root);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /">=0\.0\.9", which does not stop below/);
});

test("a stale x-range fails, caught by an implementation that reads a partial version as admitting everything", (t) => {
  const root = moduleRepo(t, "0.1.0", example("0.0.x"));
  const result = checks(root);
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /the version range "0\.0\.x", which does not stop below the next minor of 0\.1\.0/,
  );
});

test("a key that only ends in version is not read as the range, caught by an implementation that matches version after a hyphen", (t) => {
  const root = moduleRepo(
    t,
    "0.0.9",
    'source: { "api-version": "^9.0.0", package: "@antelopejs/brevo", version: ">=0.0.9 <0.1.0" }\n',
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
    '[readme:version]\nREADME.md:10 gives @antelopejs/brevo the version range "^0.9.0", which does not stop below the next minor of 0.10.0, the version in packages/dms-saas/package.json. Use ">=0.10.0 <0.11.0".\npackages/dms-saas/README.md:10 gives @antelopejs/brevo the version range "^0.9.0", which does not stop below the next minor of 0.10.0, the version in packages/dms-saas/package.json. Use ">=0.10.0 <0.11.0".\nChecks: 0 passed, 1 failed, 9 skipped.\n',
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

test("a README example of a package outside @antelopejs does not run the step, caught by an implementation that checks every example", (t) => {
  const root = moduleRepo(t, "0.0.9", example("^1.4.2", "lodash"));
  const result = checks(root);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "Checks: 0 passed, 0 failed, 9 skipped.\n");
});

/** Serves `latest` as the newest published version of `@antelopejs/mongodb`, and a 404 for any other package. */
async function registry(t: TestContext, latest: string): Promise<string> {
  const server = createServer((request, response) => {
    if (request.url !== "/@antelopejs%2fmongodb") {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ "dist-tags": { latest } }));
  });
  const port = await freePort();
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  t.after(() => server.close());
  return `http://127.0.0.1:${port}/`;
}

function checksWith(root: string, registryUrl: string) {
  return binAsync(root, "checks", ["--no-services"], {
    ANTELOPEJS_CHECKS_SKIP: OTHER_STEPS,
    npm_config_registry: registryUrl,
    NPM_CONFIG_REGISTRY: undefined,
  });
}

test("an example of another @antelopejs package on an older minor than its newest release fails, caught by an implementation that checks only the repository's own package", async (t) => {
  const root = moduleRepo(t, "0.0.9", example("~1.3.0", "@antelopejs/mongodb"));
  const result = await checksWith(root, await registry(t, "1.4.2"));
  assert.equal(result.status, 1, result.stdout);
  assert.equal(
    result.stdout,
    '[readme:version]\nREADME.md:10 gives @antelopejs/mongodb the version range "~1.3.0", which does not stop below the next minor of 1.4.2, its newest published version. Use "~1.4.2".\nChecks: 0 passed, 1 failed, 9 skipped.\n',
  );
});

test("an example of another 0.x @antelopejs package with a caret open past its next minor fails, caught by an implementation that only checks the range admits the newest release", async (t) => {
  const root = moduleRepo(
    t,
    "0.0.9",
    example("^0.3.0 || ^0.4.0", "@antelopejs/mongodb"),
  );
  const result = await checksWith(root, await registry(t, "0.4.1"));
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /Use ">=0\.4\.1 <0\.5\.0"\./);
});

test("an example of another @antelopejs package with a tilde on its newest minor passes, caught by an implementation that demands the newest release as the floor", async (t) => {
  const root = moduleRepo(t, "0.0.9", example("~1.4.0", "@antelopejs/mongodb"));
  const result = await checksWith(root, await registry(t, "1.4.2"));
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "Checks: 1 passed, 0 failed, 9 skipped.\n");
});

test("an example of an @antelopejs package the registry does not list fails and names the registry, caught by an implementation that passes a range it could not check", async (t) => {
  const root = moduleRepo(t, "0.0.9", example("~1.0.0", "@antelopejs/missing"));
  const url = await registry(t, "1.4.2");
  const result = await checksWith(root, url);
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    new RegExp(
      `"~1\\.0\\.0", but its newest published version could not be read from ${url}\\.`,
    ),
  );
});
