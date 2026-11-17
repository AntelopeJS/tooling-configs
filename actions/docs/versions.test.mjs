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

it("checks the generated block's Supported column against the package.json beside the README", (t) => {
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

it("fails a config example whose version does not select the documented module's own package.json version", (t) => {
  const manifest = JSON.stringify({ name: "@antelopejs/a", version: "0.8.1" });
  const source = (version) =>
    `source: { type: "package", package: "@antelopejs/a", version: "${version}" }`;
  const examples = [
    `\`\`\`js\n${source("^0.6.0")}\n\`\`\``,
    "```js\nsource: { version: '^0.5.0', package: '@antelopejs/a' }\n```",
    '```json\n{ "package": "@antelopejs/a",\n  "version": "~0.8.0-0 <0.8.1" }\n```',
    `Configure \`${source("0.6.0")}\`.`,
    `\`\`\`js\n${source("^0.8.0")}\n\`\`\``,
    '```json\n{ "package": "@antelopejs/a", "version": ">=0.5.0 <1.0.0" }\n```',
    '```js\nsource: { package: "@antelopejs/b", version: "^0.1.0" }\n```',
    '```js\nsource: { package: "@antelopejs/a" }\n```',
    "Open a block with `{`.",
    '```yaml\npackage: "@antelopejs/a"\n```',
    '```json\n{ "version": "9.9.9" }\n```',
    '`source: { package: "@antelopejs/a", config: { version: "v2" } }`',
    '`source: { package: "@antelopejs/a", version: "latest" }`',
  ].join("\n\n");
  const { root } = fixture(t, {
    "package.json": JSON.stringify({ name: "workspace", private: true }),
    "README.md": `# Workspace\n\n${examples}\n`,
    "packages/a/package.json": manifest,
    "packages/a/docs/setup.md": `# Setup\n\n${examples}\n`,
  });
  const { failures } = checkDocs({
    root,
    files: ["README.md", "packages/a/docs"],
  });
  assert.deepEqual(lines(failures), [
    ["README.md", "4"],
    ["README.md", "8"],
    ["README.md", "13"],
    ["README.md", "16"],
    ["packages/a/docs/setup.md", "4"],
    ["packages/a/docs/setup.md", "8"],
    ["packages/a/docs/setup.md", "13"],
    ["packages/a/docs/setup.md", "16"],
  ]);
  assert.match(
    failures[0],
    /version "\^0\.6\.0" of @antelopejs\/a does not select its package\.json version 0\.8\.1/,
  );
});

it("accepts the range pnpm pack writes for a workspace: spec and rejects any other row", (t) => {
  const { root, write } = fixture(t, {
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "package.json": JSON.stringify({ name: "root", private: true }),
    "packages/mailing/package.json": JSON.stringify({
      name: "@antelopejs/interface-dms-mailing",
      version: "0.11.1",
    }),
    "packages/app/package.json": "{}",
  });
  const run = (spec, supported) => {
    write(
      "packages/app/package.json",
      JSON.stringify({
        name: "@antelopejs/app",
        dependencies: { "@antelopejs/interface-dms-mailing": spec },
      }),
    );
    write(
      "packages/app/README.md",
      `# App\n\n${block(["@antelopejs/interface-dms-mailing", supported])}`,
    );
    return checkDocs({ root, files: ["packages/app/README.md"] }).failures;
  };
  for (const [spec, supported] of [
    ["workspace:^", "^0.11.1"],
    ["workspace:~", "~0.11.1"],
    ["workspace:*", "0.11.1"],
    ["workspace:^0.11.0", "^0.11.0"],
  ]) {
    assert.deepEqual(run(spec, supported), [], spec);
  }
  for (const [spec, supported] of [
    ["workspace:^", "workspace:^"],
    ["workspace:^", "^0.11.0"],
    ["workspace:^", "~0.11.1"],
    ["workspace:~", "^0.11.1"],
    ["workspace:*", "^0.11.1"],
  ]) {
    assert.equal(run(spec, supported).length, 1, `${spec} vs ${supported}`);
  }
});
