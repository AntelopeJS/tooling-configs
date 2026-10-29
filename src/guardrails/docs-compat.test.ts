import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { parseDocument } from "yaml";

import { ANTELOPE_STYLE } from "../oxc/fmt.ts";
import { CI_CALLER } from "./ci-workflow.ts";
import {
  compatBlock,
  DOCS_COMPAT_END,
  DOCS_COMPAT_START,
  placeCompatBlock,
} from "./docs-compat.ts";
import type { Manifest } from "./package.ts";
import { syncRepository } from "./sync.ts";
import { PACKAGE_ROOT, put, read, testRepo } from "./helpers/test-repo.ts";

function formatted(root: string, files: string[]) {
  put(root, "house-style.json", JSON.stringify(ANTELOPE_STYLE));
  return spawnSync(
    process.execPath,
    [
      join(PACKAGE_ROOT, "node_modules/oxfmt/bin/oxfmt"),
      "--config",
      "house-style.json",
      "--check",
      ...files,
    ],
    { cwd: root, encoding: "utf8" },
  );
}

function manifest(fields: Manifest): string {
  return `${JSON.stringify(fields, null, 2)}\n`;
}

const ROWS = [
  {
    name: "@antelopejs/interface-database",
    supported: "^0.1.0 || ^0.2.0",
    tested: "0.2.0",
  },
  {
    name: "@antelopejs/interface-core",
    supported: ">=0.2.4 <1.0.0",
    tested: "0.3.0",
  },
  {
    name: "@antelopejs/interface-redis",
    supported: ">=0.0.9 <1.0.0",
    tested: undefined,
  },
];

test("the block follows the contract: sorted rows, escaped unions, a dash for an unresolved version, and oxfmt leaves it as is", (t) => {
  const block = compatBlock(ROWS);
  assert.equal(
    block,
    `${DOCS_COMPAT_START}

| Package                          | Supported            | Tested with |
| -------------------------------- | -------------------- | ----------- |
| \`@antelopejs/interface-core\`     | \`>=0.2.4 <1.0.0\`     | \`0.3.0\`     |
| \`@antelopejs/interface-database\` | \`^0.1.0 \\|\\| ^0.2.0\` | \`0.2.0\`     |
| \`@antelopejs/interface-redis\`    | \`>=0.0.9 <1.0.0\`     | —           |

${DOCS_COMPAT_END}
`,
  );
  const root = testRepo(t);
  put(root, "README.md", placeCompatBlock("# Fixture\n\nIntro.\n", block));
  const check = formatted(root, ["README.md"]);
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

test("the block replaces its markers, else legacy tables, else lands under Compatibility, else is appended, and keeps the prose", () => {
  const block = compatBlock(ROWS);
  const placements: [string | undefined, string][] = [
    [
      `# A\n\nIntro.\n\n${DOCS_COMPAT_START}\n\nstale\n\n${DOCS_COMPAT_END}\n\nRequires \`@antelopejs/core\` 1.15.\n`,
      `# A\n\nIntro.\n\n${block}\nRequires \`@antelopejs/core\` 1.15.\n`,
    ],
    [
      "# A\n\n## Compatibility\n\n<!-- docs-compat: ./package.json#peerDependencies -->\n\n| Package | Range |\n| --- | --- |\n| `@antelopejs/core` | `^1` |\n\nTested on Node.js 24.\n\n<!-- docs-compat: ./package.json#dependencies -->\n| Package | Range |\n| --- | --- |\n| `@antelopejs/interface-core` | `^0.2` |\n\n## Usage\n",
      `# A\n\n## Compatibility\n\n${block}\nTested on Node.js 24.\n\n## Usage\n`,
    ],
    [
      "# A\n\n## Compatibility\n\n| Old | Table |\n| --- | --- |\n| 0.9 | 0.7 |\n\n## Usage\n",
      `# A\n\n## Compatibility\n\n${block}\n| Old | Table |\n| --- | --- |\n| 0.9 | 0.7 |\n\n## Usage\n`,
    ],
    ["# A\n\nIntro.\n", `# A\n\nIntro.\n\n## Compatibility\n\n${block}`],
    [undefined, `## Compatibility\n\n${block}`],
  ];
  for (const [current, expected] of placements) {
    const placed = placeCompatBlock(current, block);
    assert.equal(placed, expected);
    assert.equal(placeCompatBlock(placed, block), placed);
  }
});

const LOCKFILE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    devDependencies:
      '@antelopejs/core':
        specifier: ^1.17.0
        version: 1.17.2

  packages/a:
    dependencies:
      '@antelopejs/b':
        specifier: workspace:*
        version: link:../b
      '@antelopejs/interface-core':
        specifier: '>=0.2.0'
        version: 0.3.0
      '@antelopejs/interface-database':
        specifier: ^0.1.0 || ^0.2.0
        version: 0.2.0(@antelopejs/interface-core@0.3.0)
      lodash:
        specifier: ^4.17.21
        version: 4.17.21
    devDependencies:
      '@antelopejs/core':
        specifier: ^1.17.0
        version: 1.17.2(typescript@5.9.3)

  packages/b:
    devDependencies:
      '@antelopejs/core':
        specifier: ^1.17.0
        version: 1.17.2
`;

const DOCS_INPUTS = `      renovate-sync: false
      # The interface examples compile against this project.
      docs-typescript-project: packages/a/tsconfig.json
      docs-files: README.md
      extra-commands: |
        pnpm --dir packages/a check
`;

function workspace(t: TestContext): string {
  const root = testRepo(t, false);
  put(
    root,
    "package.json",
    manifest({
      name: "fixture-workspace",
      private: true,
      packageManager: "pnpm@10.2.0",
      scripts: { "sync:check": "antelopejs-sync --check" },
      devDependencies: { "@antelopejs/core": "^1.17.0" },
    }),
  );
  put(
    root,
    "pnpm-workspace.yaml",
    'packages:\n  - "packages/*"\n  - "!packages/ignored"\n  - "missing/*"\n',
  );
  put(root, "pnpm-lock.yaml", LOCKFILE);
  put(root, "README.md", "# Workspace\n\nRequires `@antelopejs/core` 1.15.\n");
  put(
    root,
    ".github/workflows/ci.yml",
    CI_CALLER.replace("      renovate-sync: false\n", DOCS_INPUTS),
  );
  put(
    root,
    "packages/a/package.json",
    manifest({
      name: "@antelopejs/a",
      version: "1.0.0",
      peerDependencies: {
        "@antelopejs/core": ">=1.17.0 <2",
        "@antelopejs/interface-core": ">=0.2.4 <1.0.0",
      },
      dependencies: {
        "@antelopejs/b": "workspace:*",
        "@antelopejs/interface-core": ">=0.2.0",
        "@antelopejs/interface-database": "^0.1.0 || ^0.2.0",
        lodash: "^4.17.21",
      },
      optionalDependencies: { "@antelopejs/interface-redis": ">=0.0.9 <1.0.0" },
      devDependencies: { "@antelopejs/core": "^1.17.0" },
    }),
  );
  put(
    root,
    "packages/a/README.md",
    "# A\n\n## Compatibility\n\n<!-- docs-compat: ./package.json#peerDependencies -->\n\n| Package | Range |\n| --- | --- |\n| `@antelopejs/core` | `>=1.17.0 <2` |\n\nRequires `@antelopejs/core` 1.15 or later.\n",
  );
  put(root, "packages/a/docs/guide.md", "# Guide\n");
  put(
    root,
    "packages/b/package.json",
    manifest({
      name: "@antelopejs/b",
      version: "0.4.1",
      devDependencies: { "@antelopejs/core": "^1.17.0" },
    }),
  );
  put(root, "packages/b/README.md", "# B\n");
  put(root, "packages/b/docs/guide.md", "# Guide\n");
  put(
    root,
    "packages/c/package.json",
    manifest({
      name: "c",
      private: true,
      dependencies: { "@antelopejs/interface-core": ">=0.2.4 <1.0.0" },
    }),
  );
  put(root, "packages/c/README.md", "# C\n");
  put(
    root,
    "packages/d/package.json",
    manifest({
      name: "@antelopejs/d",
      version: "0.1.0",
      peerDependencies: { "@antelopejs/interface-core": ">=0.2.4 <1.0.0" },
    }),
  );
  put(
    root,
    "packages/ignored/package.json",
    manifest({
      name: "ignored",
      dependencies: { "@antelopejs/interface-core": "^0.2.0" },
    }),
  );
  return root;
}

const DOCS_FILES = `README.md
packages/a/README.md
packages/a/docs
packages/d/README.md
`;

test("sync writes the block of every qualifying workspace package and the caller's docs-files, and --check reports both without writing", (t) => {
  const root = workspace(t);
  const before = ["packages/a/README.md", ".github/workflows/ci.yml"].map(
    (path) => read(root, path),
  );
  const check = syncRepository(root, { check: true });
  assert.deepEqual(check.errors, []);
  for (const path of [
    "packages/a/README.md",
    "packages/d/README.md",
    ".github/workflows/ci.yml",
  ])
    assert.ok(check.paths.includes(path), path);
  for (const path of [
    "README.md",
    "packages/b/README.md",
    "packages/c/README.md",
    "packages/ignored/README.md",
  ])
    assert.ok(!check.paths.includes(path), path);
  assert.deepEqual(
    ["packages/a/README.md", ".github/workflows/ci.yml"].map((path) =>
      read(root, path),
    ),
    before,
  );
  assert.deepEqual(syncRepository(root).errors, []);
  assert.equal(
    read(root, "packages/a/README.md"),
    `# A\n\n## Compatibility\n\n${compatBlock([
      { name: "@antelopejs/b", supported: "workspace:*", tested: "0.4.1" },
      { name: "@antelopejs/core", supported: ">=1.17.0 <2", tested: "1.17.2" },
      {
        name: "@antelopejs/interface-core",
        supported: ">=0.2.4 <1.0.0",
        tested: "0.3.0",
      },
      {
        name: "@antelopejs/interface-database",
        supported: "^0.1.0 || ^0.2.0",
        tested: "0.2.0",
      },
      {
        name: "@antelopejs/interface-redis",
        supported: ">=0.0.9 <1.0.0",
        tested: undefined,
      },
    ])}\nRequires \`@antelopejs/core\` 1.15 or later.\n`,
  );
  assert.equal(
    read(root, "packages/d/README.md"),
    `## Compatibility\n\n${compatBlock([
      {
        name: "@antelopejs/interface-core",
        supported: ">=0.2.4 <1.0.0",
        tested: undefined,
      },
    ])}`,
  );
  assert.equal(read(root, "packages/b/README.md"), "# B\n");
  assert.equal(read(root, "packages/c/README.md"), "# C\n");
  const workflow = read(root, ".github/workflows/ci.yml");
  assert.deepEqual(parseDocument(workflow).toJS().jobs.ci.with, {
    "renovate-sync": false,
    "docs-typescript-project": "packages/a/tsconfig.json",
    "docs-files": DOCS_FILES,
    "extra-commands": "pnpm --dir packages/a check\n",
  });
  assert.match(workflow, /# The interface examples compile against this/);
  const style = formatted(root, [
    ".github/workflows/ci.yml",
    "packages/a/README.md",
    "packages/d/README.md",
  ]);
  assert.equal(style.status, 0, style.stdout + style.stderr);
  assert.deepEqual(syncRepository(root, { check: true }).paths, []);
});

test("a pnpm repository without a lockfile fails naming the fix, and another manager gets a dash for every tested version", (t) => {
  const root = testRepo(t);
  put(
    root,
    "package.json",
    manifest({
      name: "@antelopejs/module",
      version: "1.0.0",
      packageManager: "pnpm@10.2.0",
      scripts: { "sync:check": "antelopejs-sync --check" },
      dependencies: { "@antelopejs/interface-core": ">=0.2.4 <1.0.0" },
    }),
  );
  put(root, "README.md", "# Module\n");
  const missing = syncRepository(root, { check: true });
  assert.match(
    missing.errors.join("\n"),
    /pnpm-lock\.yaml.*run pnpm install, then rerun antelopejs-sync/,
  );
  put(
    root,
    "package.json",
    read(root, "package.json").replace("pnpm@10.2.0", "npm@11.0.0"),
  );
  assert.deepEqual(syncRepository(root).errors, []);
  assert.equal(
    read(root, "README.md"),
    `# Module\n\n## Compatibility\n\n${compatBlock([
      {
        name: "@antelopejs/interface-core",
        supported: ">=0.2.4 <1.0.0",
        tested: undefined,
      },
    ])}`,
  );
});
