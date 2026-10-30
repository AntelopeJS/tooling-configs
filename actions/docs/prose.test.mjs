import assert from "node:assert/strict";
import { it } from "node:test";

import { checkDocs } from "./check.mjs";
import { fixture } from "./fixtures.mjs";

const lines = (failures) =>
  failures.map((failure) => failure.match(/^(\S+?):(\d+):/)?.slice(1, 3));

const block = (...rows) => `<!-- antelopejs-docs-compat:start -->

| Package | Supported | Tested with |
| ------- | --------- | ----------- |
${rows.map(([name, range]) => `| \`${name}\` | \`${range}\` | \`1.0.0\` |`).join("\n")}

<!-- antelopejs-docs-compat:end -->
`;

it("fails every @antelopejs version claim in prose, tables, and inline code with file, line, and fix", (t) => {
  const { root } = fixture(t, {
    "README.md": [
      "# Package",
      "Install `@antelopejs/core@1.2.3` first.",
      "Tested against `@antelopejs/core` `^1.13.4` on Node.js 24.",
      "Works with @antelopejs/interface-core ~1 today.",
      "Needs `@antelopejs/interface-database` >=0.1.1 <1.0.0.",
      "Any @antelopejs/mongodb 1.x release.",
      "",
      "| Package | Range |",
      "| --- | --- |",
      "| `@antelopejs/interface-mongodb` | `>=0.0.5 <1.0.0` |",
      "",
      "The playground requires AntelopeJS core 1.16.0 or later.",
      "The store requires `@antelopejs/dms-frontend` 0.6.1 or later.",
      "Older hosts: requires @antelopejs/core >= 1.15.",
      "The `@antelopejs/core`",
      "1.15.2 release.",
      "",
      "| `@antelopejs/dms` | `@antelopejs/dms-frontend` |",
      "| --- | --- |",
      "| 0.9 | `>=0.6.1 <0.7.0` |",
      "",
      "`@antelopejs/interface-database` version `0.1.6` or later.",
      "@antelopejs/interface-database version `0.1.6`.",
      "Requires @antelopejs/core (>= 1.16).",
      "@antelopejs/core (^1.16.0) is a peer.",
      "Raise `@antelopejs/interface-dms` to `>=0.8.0 <1.0.0`.",
      "Declares `@antelopejs/core` as `^1.2.0`.",
      "Requires AntelopeJS core `1.x`.",
      "* @antelopejs/core — ^1.16.0",
      "Requires @antelopejs/core v1.",
      'Set `"@antelopejs/core": "^1.16.0"`.',
      "",
      "| Package | Before |",
      "| --- | --- |",
      "| playground `@antelopejs/mongodb` / `api` | `^1.3.1` |",
      "",
      "Requires @antelopejs/core at version 1.16 or later.",
      "Needs the @antelopejs/core package at 1.16 or later.",
      "Requires the `@antelopejs/core` package, version 1.16 or later.",
      "Requires the AntelopeJS core, 1.16 or later.",
    ].join("\n"),
    "docs/guide.md":
      "---\ntitle: Guide\ndescription: Written for @antelopejs/interface-dms 0.3.\n---\n# Guide\n\nUse `@antelopejs/interface-dms` 0.4.\n",
  });
  const { failures } = checkDocs({ root, files: ["README.md", "docs"] });
  assert.deepEqual(lines(failures), [
    ["README.md", "2"],
    ["README.md", "3"],
    ["README.md", "4"],
    ["README.md", "5"],
    ["README.md", "6"],
    ["README.md", "10"],
    ["README.md", "12"],
    ["README.md", "13"],
    ["README.md", "14"],
    ["README.md", "15"],
    ["README.md", "20"],
    ["README.md", "22"],
    ["README.md", "23"],
    ["README.md", "24"],
    ["README.md", "25"],
    ["README.md", "26"],
    ["README.md", "27"],
    ["README.md", "28"],
    ["README.md", "29"],
    ["README.md", "30"],
    ["README.md", "31"],
    ["README.md", "35"],
    ["README.md", "37"],
    ["README.md", "38"],
    ["README.md", "39"],
    ["README.md", "40"],
    ["docs/guide.md", "3"],
    ["docs/guide.md", "7"],
  ]);
  for (const failure of failures) {
    assert.match(failure, /run antelopejs-sync.*delete the prose/);
  }
  assert.match(failures[1], /@antelopejs\/core.*\^1\.13\.4/);
  assert.match(
    failures[10],
    /"@antelopejs\/dms 0\.9".*"@antelopejs\/dms-frontend >=0\.6\.1 <0\.7\.0"/,
  );
});

it("accepts badges, URLs, unversioned names, other packages, Node.js versions, fences, and unselected changelogs", (t) => {
  const { root } = fixture(t, {
    "README.md": `# Package

[![npm](https://img.shields.io/npm/v/@antelopejs/mongodb)](https://www.npmjs.com/package/@antelopejs/mongodb/v/1.2.3)
<img src="https://img.shields.io/npm/v/@antelopejs/core/1.2.3">

This module implements \`@antelopejs/interface-database\`, see \`@antelopejs/interface-core/modules\` (3 functions).
It needs the \`mongodb\` driver \`^6.21.0\` and \`zod\` >=3.0.0 <4.
You need Node.js 22 or later; the CLI requires Node.js >= 22.18 and pnpm 9 or later.
The DMS requires 0.5 or later of the frontend.
Use @antelopejs/dms-frontend@<version> from npm.

<!-- @antelopejs/core ^1.0.0 -->

\`\`\`bash
pnpm add @antelopejs/core@1 @antelopejs/interface-core@^0.2.4
\`\`\`

\`\`\`json fragment
{ "peerDependencies": { "@antelopejs/core": "^1.13.4" } }
\`\`\`

    @antelopejs/core ^1.0.0 in an indented code block

| Package | Range |
| --- | --- |
| \`zod\` | \`^3.0.0\` |
| \`@antelopejs/core\` | latest |

| Package | Modules |
| --- | --- |
| \`@antelopejs/core\` | 3 |

| Package | Size | Node |
| --- | --- | --- |
| \`@antelopejs/core\` | 1.2 MB | >=22 |

The CLI needs AntelopeJS and Node 22.18 or later.
Startup with @antelopejs/core (2.5 seconds).
Builds with @antelopejs/core — 3.5x faster.
Point @antelopejs/mongodb at 127.0.0.1 locally.
The CLI needs AntelopeJS, pnpm 9 or later.
`,
    "CHANGELOG.md": "# 1.2.0\n\nRequires `@antelopejs/core` ^1.2.0.\n",
  });
  assert.deepEqual(checkDocs({ root, files: ["README.md"] }).failures, []);
});

it("exempts the generated block and checks its Supported column against the package.json beside the README", (t) => {
  const { root, write } = fixture(t, {
    "packages/a/package.json": JSON.stringify({
      name: "@antelopejs/a",
      dependencies: {
        "@antelopejs/interface-core": ">=0.2.4 <1.0.0",
        zod: "^3.0.0",
      },
      optionalDependencies: { "@antelopejs/interface-database": "^0.1.0" },
      peerDependencies: { "@antelopejs/core": "^1.0.0 || ^2.0.0" },
      devDependencies: { "@antelopejs/tooling-configs": "^0.2.0" },
    }),
  });
  const rows = [
    ["@antelopejs/core", "^1.0.0 \\|\\| ^2.0.0"],
    ["@antelopejs/interface-core", ">=0.2.4 <1.0.0"],
    ["@antelopejs/interface-database", "^0.1.0"],
  ];
  const readme = (compat) =>
    `# A\n\n## Compatibility\n\n${compat}\nSee also @antelopejs/core.\n`;
  write("packages/a/README.md", readme(block(...rows)));
  const run = () =>
    checkDocs({ root, files: ["packages/a/README.md"] }).failures;
  assert.deepEqual(run(), []);
  write(
    "packages/a/README.md",
    readme(
      block(rows[0], ["@antelopejs/interface-core", ">=0.2.4 <1"], rows[2]),
    ),
  );
  assert.deepEqual(run(), []);

  write(
    "packages/a/README.md",
    readme(block(rows[0], ["@antelopejs/interface-core", "^0.2.4"], rows[2])),
  );
  assert.deepEqual(lines(run()), [["packages/a/README.md", "10"]]);
  assert.match(run()[0], /@antelopejs\/interface-core.*run antelopejs-sync/);

  write("packages/a/README.md", readme(block(rows[0], rows[1])));
  assert.match(run().join("\n"), /@antelopejs\/interface-database.*missing/);

  write(
    "packages/a/README.md",
    readme(block(...rows, ["@antelopejs/tooling-configs", "^0.2.0"])),
  );
  assert.match(run().join("\n"), /@antelopejs\/tooling-configs.*not declared/);

  write(
    "packages/a/README.md",
    `${readme(block(...rows))}\nTested with \`@antelopejs/core\` \`1.0.0\`.\n`,
  );
  assert.deepEqual(lines(run()), [["packages/a/README.md", "17"]]);

  write(
    "packages/a/README.md",
    "# A\n\n<!-- antelopejs-docs-compat:start -->\n\nNo table\n",
  );
  assert.match(
    run().join("\n"),
    /start has no end marker.*run antelopejs-sync/,
  );

  write(
    "packages/a/README.md",
    "# A\n\n<!-- antelopejs-docs-compat:start -->\n\nNo table\n\n<!-- antelopejs-docs-compat:end -->\n",
  );
  assert.match(run().join("\n"), /needs a Package and Supported table/);
});

it("fails a generated block with no package.json beside it", (t) => {
  const { root } = fixture(t, {
    "docs/guide.md": block(["@antelopejs/core", "^1.0.0"]),
  });
  const { failures } = checkDocs({ root, files: ["docs"] });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /docs\/guide\.md:1:.*package\.json/);
});

it("treats a legacy docs-compat table as manifest-checked, not as prose", (t) => {
  const { root } = fixture(t, {
    "package.json": JSON.stringify({
      peerDependencies: { "@antelopejs/core": "^1.2.0" },
    }),
    "README.md": `# Package

<!-- docs-compat: ./package.json#peerDependencies -->

| Package | Range |
| --- | --- |
| \`@antelopejs/core\` | \`^1.2.0\` |
`,
  });
  assert.deepEqual(checkDocs({ root, files: ["README.md"] }).failures, []);
});
