import assert from "node:assert/strict";
import test from "node:test";

import { bin, linkOxlint, put, read, testRepo } from "./helpers/test-repo.ts";

const START = "<!-- antelopejs-docs-node:start -->";
const END = "<!-- antelopejs-docs-node:end -->";
const BLOCK = `${START}\nThis package requires Node.js \`>=22.18.0\`.\n${END}`;

interface FixtureManifest {
  name: string;
  type: string;
  packageManager: string;
  engines?: { node: string };
  antelopeJs?: { docs: { standard: boolean } };
}

function repo(
  t: test.TestContext,
  options: { standard?: boolean; engines?: string | null } = {},
): string {
  const standard = options.standard ?? true;
  const engines = options.engines === undefined ? ">=22.18.0" : options.engines;
  const root = testRepo(t);
  linkOxlint(root);
  put(
    root,
    "oxlint.config.ts",
    'import type {} from "@antelopejs/tooling-configs/oxc/lint";\nexport default {};\n',
  );
  const manifest: FixtureManifest = {
    name: "fixture",
    type: "module",
    packageManager: "npm@11.0.0",
  };
  if (engines !== null) manifest.engines = { node: engines };
  if (standard) manifest.antelopeJs = { docs: { standard: true } };
  put(root, "package.json", JSON.stringify(manifest));
  return root;
}

test("sync adds a Requirements section with the generated Node block from engines", (t) => {
  const root = repo(t);
  put(root, "README.md", "# Fixture\n\nIntro.\n");
  const result = bin(root, "sync");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    read(root, "README.md"),
    `# Fixture\n\nIntro.\n\n## Requirements\n\n${BLOCK}\n`,
  );
});

test("sync rewrites a stale block in place and --check reports it as drift", (t) => {
  const root = repo(t);
  put(
    root,
    "README.md",
    `# Fixture\n\n${START}\nThis package requires Node.js \`>=20\`.\n${END}\n\nMore.\n`,
  );
  const check = bin(root, "sync", ["--check"]);
  assert.equal(check.status, 1);
  assert.match(check.stdout, /Drift: README\.md; run antelopejs-sync\n/);
  assert.equal(bin(root, "sync").status, 0);
  assert.equal(read(root, "README.md"), `# Fixture\n\n${BLOCK}\n\nMore.\n`);
  assert.equal(
    bin(root, "sync", ["--check"]).stdout,
    "Guardrails are in sync.\n",
  );
});

test("sync places the block under an existing Requirements heading", (t) => {
  const root = repo(t);
  put(
    root,
    "README.md",
    "# Fixture\n\n## Requirements\n\n## Usage\n\nRun it.\n",
  );
  assert.equal(bin(root, "sync").status, 0);
  assert.equal(
    read(root, "README.md"),
    `# Fixture\n\n## Requirements\n\n${BLOCK}\n\n## Usage\n\nRun it.\n`,
  );
});

test("sync leaves the README alone without the opt-in, without engines, and without a README", (t) => {
  const plain = repo(t, { standard: false });
  put(plain, "README.md", "# Fixture\n");
  assert.equal(bin(plain, "sync").status, 0);
  assert.equal(read(plain, "README.md"), "# Fixture\n");
  const noEngines = repo(t, { engines: null });
  put(noEngines, "README.md", "# Fixture\n");
  assert.equal(bin(noEngines, "sync").status, 0);
  assert.equal(read(noEngines, "README.md"), "# Fixture\n");
  const noReadme = repo(t);
  assert.equal(bin(noReadme, "sync").status, 0);
  assert.equal(
    bin(noReadme, "sync", ["--check"]).stdout,
    "Guardrails are in sync.\n",
  );
});
