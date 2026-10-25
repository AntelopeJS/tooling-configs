import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  agentsBlock,
  AGENTS_BLOCK_END,
  AGENTS_BLOCK_START,
} from "./agents-block.ts";
import { ANTELOPE_STYLE } from "../oxc/fmt.ts";
import { formatCeilings, readCeilings } from "./ceilings.ts";
import { parseManifest, PREPARE_INSTALL, toolingVersions } from "./package.ts";
import { MANAGED_ARTIFACTS, syncRepository } from "./sync.ts";
import {
  bin,
  linkOxlint,
  PACKAGE_ROOT,
  put,
  read,
  testRepo,
} from "./helpers/test-repo.ts";

test("full sync measures once, preserves handwritten text even behind a CLAUDE symlink, and does not rewrite on a second run", (t) => {
  const root = testRepo(t);
  linkOxlint(root);
  put(
    root,
    "oxlint.config.ts",
    'import type {} from "@antelopejs/tooling-configs/oxc/lint";\nexport default { categories: { correctness: "off" }, rules: { "typescript/no-explicit-any": "error" } };\n',
  );
  put(root, "sample.ts", "export let value: any;\n");
  put(
    root,
    "AGENTS.md",
    `Handwritten introduction.\n\n${AGENTS_BLOCK_START}\nstale content\n${AGENTS_BLOCK_END}\n\nHandwritten footer.\n`,
  );
  symlinkSync("AGENTS.md", join(root, "CLAUDE.md"));
  put(root, ".agents/skills/verify-runtime/SKILL.md", "Verification skill.\n");
  put(root, "docs/GLOSSARY.md", "Glossary.\n");
  put(
    root,
    "package.json",
    JSON.stringify(
      {
        name: "fixture",
        type: "module",
        packageManager: "npm@11.0.0",
        scripts: {
          prepare: "node prepare.mjs",
          typecheck: "custom-typecheck",
          test: "custom-test",
        },
        devDependencies: { knip: "^6.0.0" },
      },
      null,
      4,
    ) + "\n",
  );
  const first = bin(root, "sync");
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Run install/);
  assert.deepEqual(readCeilings(root).rules, {
    "typescript/no-explicit-any": 1,
  });
  assert.equal(
    read(root, "AGENTS.md"),
    `Handwritten introduction.\n\n${agentsBlock({ profile: "full", verificationSkill: ".agents/skills/verify-runtime/SKILL.md", glossary: "docs/GLOSSARY.md" }).trimEnd()}\n\nHandwritten footer.\n`,
  );
  assert.equal(read(root, "CLAUDE.md"), "@AGENTS.md\n");
  const packageText = read(root, "package.json");
  assert.match(packageText, /\n {4}"name"/);
  assert.ok(packageText.indexOf('"name"') < packageText.indexOf('"type"'));
  const manifest = parseManifest(packageText);
  assert.equal(manifest.scripts?.typecheck, "custom-typecheck");
  assert.equal(manifest.scripts?.test, "custom-test");
  assert.equal(
    manifest.scripts?.prepare,
    `node prepare.mjs && ${PREPARE_INSTALL}`,
  );
  assert.equal(manifest.scripts?.checks, "antelopejs-checks");
  assert.equal(manifest.devDependencies?.knip, "^6.0.0");
  assert.equal(manifest.devDependencies?.lefthook, toolingVersions().lefthook);
  assert.match(
    read(root, "lefthook.yml"),
    /npm exec -- oxfmt --no-error-on-unmatched-pattern \{staged_files\}/,
  );
  const mtimes = MANAGED_ARTIFACTS.map(
    ({ path }) => statSync(join(root, path)).mtimeMs,
  );
  const second = bin(root, "sync");
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, "Guardrails are in sync.\n");
  assert.deepEqual(
    MANAGED_ARTIFACTS.map(({ path }) => statSync(join(root, path)).mtimeMs),
    mtimes,
  );
  assert.equal(bin(root, "sync", ["--check"]).status, 0);
});

test("sync check reports every drift without writing or measuring counts, including setup permissions", (t) => {
  const root = testRepo(t);
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({ rules: { "eslint/max-params": 123 }, oversizeFiles: {} }),
  );
  const before = read(root, "package.json");
  const initial = bin(root, "sync", ["--check"]);
  assert.equal(initial.status, 1);
  for (const path of MANAGED_ARTIFACTS.filter(
    ({ path }) => path !== "guardrails.ratchet.json",
  ).map(({ path }) => path))
    assert.ok(
      initial.stdout.includes(`Drift: ${path}; run antelopejs-sync`),
      path,
    );
  assert.equal(read(root, "package.json"), before);
  assert.equal(existsSync(join(root, ".agents/setup")), false);
  assert.equal(bin(root, "sync").status, 0);
  assert.equal(bin(root, "sync", ["--check"]).status, 0);
  chmodSync(join(root, ".agents/setup"), 0o644);
  const permission = bin(root, "sync", ["--check"]);
  assert.equal(permission.status, 1);
  assert.equal(
    permission.stdout,
    "Drift: .agents/setup; run antelopejs-sync\n",
  );
  assert.equal(bin(root, "sync").status, 0);
  assert.equal(statSync(join(root, ".agents/setup")).mode & 0o777, 0o755);
});

test("template profile manages only presets and AGENTS, and appends without replacing handwritten content", (t) => {
  const root = testRepo(t);
  const originalPackage = read(root, "package.json");
  put(root, "AGENTS.md", "Handwritten without a final newline.");
  put(
    root,
    "oxfmt.config.ts",
    'import { antelopeFmtPreset } from "@antelopejs/tooling-configs/oxc/fmt";\nexport default antelopeFmtPreset({ printWidth: 99 });\n',
  );
  const customFormatter = read(root, "oxfmt.config.ts");
  const result = syncRepository(root, { profile: "template" });
  assert.deepEqual(result.paths.sort(), [
    "AGENTS.md",
    "knip.config.ts",
    "oxlint.config.ts",
  ]);
  assert.equal(read(root, "package.json"), originalPackage);
  assert.equal(read(root, "oxfmt.config.ts"), customFormatter);
  assert.match(
    read(root, "AGENTS.md"),
    /^Handwritten without a final newline\.\n\n/,
  );
  assert.match(
    read(root, "oxlint.config.ts"),
    /options: \{ typeAware: true \}/,
  );
  for (const path of [
    "CLAUDE.md",
    "lefthook.yml",
    ".nvmrc",
    ".agents/setup",
    "guardrails.ratchet.json",
  ])
    assert.equal(existsSync(join(root, path)), false, path);
  assert.equal(
    bin(root, "sync", ["--check", "--profile", "template"]).status,
    0,
  );
  assert.equal(bin(root, "sync", ["--profile", "invalid"]).status, 1);
});

test("initial full sync fails before writing when oxlint is absent rather than recording an empty baseline", (t) => {
  const root = testRepo(t);
  const result = bin(root, "sync");
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /oxlint is not installed.*Install dependencies first/,
  );
  assert.equal(existsSync(join(root, "guardrails.ratchet.json")), false);
  assert.equal(existsSync(join(root, "oxlint.config.ts")), false);
});

test("sync keeps an oxfmt-formatted repository formatted, so formatting never reports sync drift", (t) => {
  const root = testRepo(t);
  linkOxlint(root);
  put(
    root,
    "package.json",
    `${JSON.stringify(
      {
        name: "fixture",
        type: "module",
        scripts: { test: "node --test" },
        devDependencies: { "@types/node": "^24.0.0", zod: "^4.0.0" },
        packageManager: "npm@11.0.0",
      },
      null,
      2,
    )}\n`,
  );
  put(root, "AGENTS.md", "# Fixture\n\nHandwritten guidance.\n");
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({ rules: {}, oversizeFiles: {} }),
  );
  const sync = bin(root, "sync");
  assert.equal(sync.status, 0, sync.stderr);
  put(root, "house-style.json", JSON.stringify(ANTELOPE_STYLE));
  const oxfmt = spawnSync(
    process.execPath,
    [
      join(PACKAGE_ROOT, "node_modules/oxfmt/bin/oxfmt"),
      "--config",
      "house-style.json",
      "--check",
      "package.json",
      "AGENTS.md",
      "lefthook.yml",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(oxfmt.status, 0, oxfmt.stdout + oxfmt.stderr);
});
