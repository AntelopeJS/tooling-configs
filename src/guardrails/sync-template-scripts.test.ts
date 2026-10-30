import assert from "node:assert/strict";
import test from "node:test";

import { formatCeilings } from "./ceilings.ts";
import { parseManifest } from "./package.ts";
import { syncRepository } from "./sync.ts";
import { bin, commit, put, read, testRepo } from "./helpers/test-repo.ts";

const TEMPLATE_SCRIPTS = {
  checks: "antelopejs-checks",
  sync: "antelopejs-sync --profile template",
  "sync:check": "antelopejs-sync --profile template --check",
};

const DEBT = formatCeilings({
  rules: { "typescript/no-unsafe-assignment": 3 },
  oversizeFiles: {},
});

function templateRepo(
  t: Parameters<typeof testRepo>[0],
  scripts: Record<string, string>,
  ratchetFile = false,
): string {
  const root = testRepo(t);
  put(
    root,
    "package.json",
    `${JSON.stringify({ name: "template-test", type: "module", packageManager: "npm@11.0.0", scripts }, null, 2)}\n`,
  );
  if (ratchetFile) put(root, "guardrails.ratchet.json", DEBT);
  commit(root);
  return root;
}

function scriptsOf(root: string) {
  return parseManifest(read(root, "package.json")).scripts ?? {};
}

test("template sync writes the ratchet scripts that checks requires once a ratchet file exists (#88)", (t) => {
  const root = templateRepo(t, TEMPLATE_SCRIPTS, true);
  const result = syncRepository(root, { profile: "template" });
  assert.deepEqual(result.errors, []);
  assert.equal(scriptsOf(root).ratchet, "antelopejs-ratchet");
  assert.equal(
    scriptsOf(root)["ratchet:update"],
    "antelopejs-ratchet --update",
  );
  assert.equal(
    bin(root, "sync", ["--check", "--profile", "template"]).status,
    0,
  );
});

test("template sync writes the suppressions scripts that checks requires (#88)", (t) => {
  const root = templateRepo(t, TEMPLATE_SCRIPTS);
  syncRepository(root, { profile: "template" });
  assert.equal(scriptsOf(root).suppressions, "antelopejs-suppressions");
  assert.equal(
    scriptsOf(root)["suppressions:update"],
    "antelopejs-suppressions --update",
  );
});

test("template sync --check reports a missing script and writes nothing (#88)", (t) => {
  const root = templateRepo(t, TEMPLATE_SCRIPTS, true);
  const before = read(root, "package.json");
  const result = syncRepository(root, { check: true, profile: "template" });
  assert.ok(result.paths.includes("package.json"));
  assert.equal(read(root, "package.json"), before);
  assert.equal(
    bin(root, "sync", ["--check", "--profile", "template"]).status,
    1,
  );
});

test("template sync adds no ratchet script while there is no ratchet file", (t) => {
  const root = templateRepo(t, TEMPLATE_SCRIPTS);
  syncRepository(root, { profile: "template" });
  assert.equal(scriptsOf(root).ratchet, undefined);
  assert.equal(scriptsOf(root)["ratchet:update"], undefined);
});

test("template sync keeps the template profile's own scripts and leaves a complete package.json byte for byte", (t) => {
  const root = templateRepo(
    t,
    {
      ...TEMPLATE_SCRIPTS,
      ratchet: "antelopejs-ratchet",
      "ratchet:update": "antelopejs-ratchet --update",
      suppressions: "antelopejs-suppressions",
      "suppressions:update": "antelopejs-suppressions --update",
    },
    true,
  );
  const before = read(root, "package.json");
  syncRepository(root, { profile: "template" });
  assert.equal(read(root, "package.json"), before);
});

test("template sync keeps the template profile sync scripts while it adds the missing ones", (t) => {
  const root = templateRepo(t, TEMPLATE_SCRIPTS, true);
  syncRepository(root, { profile: "template" });
  const scripts = scriptsOf(root);
  assert.equal(scripts.sync, TEMPLATE_SCRIPTS.sync);
  assert.equal(scripts["sync:check"], TEMPLATE_SCRIPTS["sync:check"]);
  assert.equal(scripts.checks, TEMPLATE_SCRIPTS.checks);
});
