import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  DMS_MODULES_END,
  DMS_MODULES_START,
  modulesBlock,
  placeModulesBlock,
} from "./docs-modules.ts";
import { syncRepository } from "./sync.ts";
import { formatCheck, put, read, testRepo } from "./helpers/test-repo.ts";

const BLOCK = `${DMS_MODULES_START}

| Module                                                           | What it adds                                                                             |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [\`dms-builder\`](https://github.com/AntelopeJS/dms-builder)       | Edit pages, tables and data sources by clicking, as TypeScript that compiles             |
| [\`dms-ai\`](https://github.com/AntelopeJS/dms-ai)                 | An assistant chat in the dashboard, on your own Claude Code or Codex                     |
| [\`dms-database\`](https://github.com/AntelopeJS/dms-database)     | Schemas, relation diagrams, a data browser and a query console                           |
| [\`dms-api\`](https://github.com/AntelopeJS/dms-api)               | API health, request logs, per-route statistics and a request tester                      |
| [\`dms-automation\`](https://github.com/AntelopeJS/dms-automation) | Node-graph automations on schedules, webhooks and DMS events, with a trace for every run |
| [\`dms-mailing\`](https://github.com/AntelopeJS/dms-mailing)       | E-mail templates in a block editor, versions, a send log and delivery metrics            |
| [\`dms-lang\`](https://github.com/AntelopeJS/dms-lang)             | Translation coverage, a translation matrix and a translation queue                       |
| [\`dms-media\`](https://github.com/AntelopeJS/dms-media)           | A media library with folders, per-folder permissions, image sizes and light editing      |
| [\`dms-saas\`](https://github.com/AntelopeJS/dms-saas)             | Self-service sign-up, plans that gate features, and Stripe billing                       |
| [\`dms-marketing\`](https://github.com/AntelopeJS/dms-marketing)   | Traffic, conversion funnels with A/B splits and click heatmaps, without cookies          |
| [\`dms-frontend\`](https://github.com/AntelopeJS/dms-frontend)     | The \`ajs dms\` CLI, the Vue renderer and the SDK every frontend module builds on          |

${DMS_MODULES_END}
`;

const STALE = `${DMS_MODULES_START}

| Module | What it adds |
| ------ | ------------ |
| old    | A removed module |

${DMS_MODULES_END}
`;

function repoWithReadme(t: TestContext, readme: string): string {
  const root = testRepo(t);
  put(
    root,
    "package.json",
    `${JSON.stringify(
      {
        name: "dms-example",
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

test("the block is byte for byte the module table, and oxfmt leaves it as is", (t) => {
  assert.equal(modulesBlock(), BLOCK);
  const root = repoWithReadme(t, `# Example\n\n${BLOCK}`);
  const check = formatCheck(root, ["README.md"]);
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

test("a stale block is drift that sync rewrites in place, keeping the text around it", (t) => {
  const root = repoWithReadme(
    t,
    `# Example\n\nIntro.\n\n${STALE}\n## Licence\n\nApache-2.0.\n`,
  );
  const before = read(root, "README.md");
  const check = syncRepository(root, { check: true });
  assert.deepEqual(check.errors, []);
  assert.ok(check.paths.includes("README.md"));
  assert.equal(read(root, "README.md"), before);
  assert.deepEqual(syncRepository(root).errors, []);
  assert.equal(
    read(root, "README.md"),
    `# Example\n\nIntro.\n\n${BLOCK}\n## Licence\n\nApache-2.0.\n`,
  );
  assert.deepEqual(syncRepository(root, { check: true }).paths, []);
});

test("a README without the markers gets no table, and --check stays clean", (t) => {
  const root = repoWithReadme(t, "# Example\n\nIntro.\n");
  assert.deepEqual(syncRepository(root).errors, []);
  assert.equal(read(root, "README.md"), "# Example\n\nIntro.\n");
  assert.deepEqual(syncRepository(root, { check: true }).paths, []);
});

test("a start marker without its end marker, or an end before its start, is an error naming the fix", (t) => {
  for (const broken of [
    `# Example\n\n${DMS_MODULES_START}\n\nNo end.\n`,
    `# Example\n\n${DMS_MODULES_END}\n\n${DMS_MODULES_START}\n`,
  ]) {
    const root = repoWithReadme(t, broken);
    const { errors } = syncRepository(root, { check: true });
    assert.match(
      errors.join("\n"),
      /README\.md: incomplete antelopejs-dms-modules markers.*rerun antelopejs-sync/,
    );
    assert.throws(() => placeModulesBlock(broken), /incomplete/);
  }
});
