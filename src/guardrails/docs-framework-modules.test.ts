import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  FRAMEWORK_MODULES_END,
  FRAMEWORK_MODULES_START,
  frameworkModulesBlock,
} from "./docs-framework-modules.ts";
import { syncRepository } from "./sync.ts";
import { formatCheck, put, read, testRepo } from "./helpers/test-repo.ts";

const EMAIL_TABLE = `| Area         | Contracts                                                                                                                                                                                                                                                                                                                                                                                                                  | Providers                                                                                                                                                                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API          | [\`interface-api\`](https://github.com/AntelopeJS/interface-api) · [\`interface-api-util\`](https://github.com/AntelopeJS/interface-api-util) · [\`interface-data-api\`](https://github.com/AntelopeJS/interface-data-api)                                                                                                                                                                                                       | [\`api\`](https://github.com/AntelopeJS/api)                                                                                                                                                                                                          |
| Auth         | [\`interface-auth\`](https://github.com/AntelopeJS/interface-auth)                                                                                                                                                                                                                                                                                                                                                           | [\`auth-jwt\`](https://github.com/AntelopeJS/auth-jwt)                                                                                                                                                                                                |
| Database     | [\`interface-database\`](https://github.com/AntelopeJS/interface-database) · [\`interface-database-decorators\`](https://github.com/AntelopeJS/interface-database-decorators) · [\`interface-database-catalog\`](https://github.com/AntelopeJS/interface-database-catalog) · [\`interface-mongodb\`](https://github.com/AntelopeJS/interface-mongodb) · [\`interface-rethinkdb\`](https://github.com/AntelopeJS/interface-rethinkdb) | [\`postgres\`](https://github.com/AntelopeJS/postgres) · [\`mongodb\`](https://github.com/AntelopeJS/mongodb) · [\`rethinkdb\`](https://github.com/AntelopeJS/rethinkdb)                                                                                  |
| Redis        | [\`interface-redis\`](https://github.com/AntelopeJS/interface-redis) · [\`interface-redis-scheduler\`](https://github.com/AntelopeJS/interface-redis-scheduler)                                                                                                                                                                                                                                                                | [\`redis\`](https://github.com/AntelopeJS/redis)                                                                                                                                                                                                      |
| Email        | **\`interface-email\`**                                                                                                                                                                                                                                                                                                                                                                                                      | [\`nodemailer\`](https://github.com/AntelopeJS/nodemailer) · [\`brevo\`](https://github.com/AntelopeJS/brevo)                                                                                                                                           |
| File storage | [\`interface-file-storage\`](https://github.com/AntelopeJS/interface-file-storage)                                                                                                                                                                                                                                                                                                                                           | [\`file-storage-local\`](https://github.com/AntelopeJS/file-storage-local) · [\`file-storage-s3\`](https://github.com/AntelopeJS/file-storage-s3)                                                                                                       |
| Payments     | [\`interface-payment\`](https://github.com/AntelopeJS/interface-payment) · [\`interface-subscriptions\`](https://github.com/AntelopeJS/interface-subscriptions) · [\`interface-stripe\`](https://github.com/AntelopeJS/interface-stripe)                                                                                                                                                                                         | [\`stripe\`](https://github.com/AntelopeJS/stripe) · [\`mollie\`](https://github.com/AntelopeJS/mollie) · [\`checkout-com\`](https://github.com/AntelopeJS/checkout-com) · [\`payment-subscriptions\`](https://github.com/AntelopeJS/payment-subscriptions) |`;

const EMAIL_BLOCK = `${FRAMEWORK_MODULES_START}\n\n${EMAIL_TABLE}\n\n${FRAMEWORK_MODULES_END}\n`;

const STALE = `${FRAMEWORK_MODULES_START}

| Area | Contracts | Providers |
| ---- | --------- | --------- |
| Old  | removed   | removed   |

${FRAMEWORK_MODULES_END}
`;

function repoWithReadme(t: TestContext, name: string, readme: string): string {
  const root = testRepo(t);
  put(
    root,
    "package.json",
    `${JSON.stringify(
      {
        name,
        scripts: { "sync:check": "antelopejs-sync --check" },
        version: "1.0.0",
        packageManager: "npm@11.0.0",
      },
      null,
      2,
    )}\n`,
  );
  put(root, "README.md", readme);
  return root;
}

test("the block is the approved framework table with the README's own repository in bold, and oxfmt leaves it as is", (t) => {
  assert.equal(frameworkModulesBlock("interface-email"), EMAIL_BLOCK);
  const root = repoWithReadme(
    t,
    "@antelopejs/interface-email",
    `# Example\n\n${EMAIL_BLOCK}`,
  );
  const check = formatCheck(root, ["README.md"]);
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

test("a stale block is drift that sync rewrites in place for the package's own repository, keeping the text around it", (t) => {
  const root = repoWithReadme(
    t,
    "@antelopejs/interface-email",
    `# Example\n\n## Part of AntelopeJS\n\nIntro.\n\n${STALE}\n## License\n\nApache-2.0.\n`,
  );
  const before = read(root, "README.md");
  const check = syncRepository(root, { check: true });
  assert.deepEqual(check.errors, []);
  assert.ok(check.paths.includes("README.md"));
  assert.equal(read(root, "README.md"), before);
  assert.deepEqual(syncRepository(root).errors, []);
  assert.equal(
    read(root, "README.md"),
    `# Example\n\n## Part of AntelopeJS\n\nIntro.\n\n${EMAIL_BLOCK}\n## License\n\nApache-2.0.\n`,
  );
  assert.deepEqual(syncRepository(root, { check: true }).paths, []);
});

test("a provider README bolds its own repository and links every other one", (t) => {
  const root = repoWithReadme(
    t,
    "@antelopejs/postgres",
    `# Example\n\n${STALE}`,
  );
  assert.deepEqual(syncRepository(root).errors, []);
  const readme = read(root, "README.md");
  assert.match(readme, /\| \*\*`postgres`\*\* · \[`mongodb`\]/);
  assert.match(
    readme,
    /\[`interface-email`\]\(https:\/\/github\.com\/AntelopeJS\/interface-email\)/,
  );
  assert.doesNotMatch(readme, /\*\*`interface-email`\*\*/);
});

test("a package outside the table gets the table with no repository in bold", (t) => {
  const root = repoWithReadme(
    t,
    "@antelopejs/interface-core",
    `# Example\n\n${STALE}`,
  );
  assert.deepEqual(syncRepository(root).errors, []);
  assert.doesNotMatch(read(root, "README.md"), /\*\*/);
  assert.equal(
    read(root, "README.md"),
    `# Example\n\n${frameworkModulesBlock(undefined)}`,
  );
});

test("a README without the markers gets no table, and --check stays clean", (t) => {
  const root = repoWithReadme(t, "@antelopejs/redis", "# Example\n\nIntro.\n");
  assert.deepEqual(syncRepository(root).errors, []);
  assert.equal(read(root, "README.md"), "# Example\n\nIntro.\n");
  assert.deepEqual(syncRepository(root, { check: true }).paths, []);
});

test("a start marker without its end marker is an error naming the fix, and sync writes nothing", (t) => {
  const readme = `# X\n\n${FRAMEWORK_MODULES_START}\n\nKeep me.\n`;
  const root = repoWithReadme(t, "@antelopejs/redis", readme);
  for (const check of [true, false]) {
    const { errors } = syncRepository(root, { check });
    assert.match(
      errors.join("\n"),
      /README\.md: invalid antelopejs-framework-modules markers.*rerun antelopejs-sync/,
    );
    assert.equal(read(root, "README.md"), readme);
  }
});
