import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, rmSync, statSync, symlinkSync } from "node:fs";
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
  commit,
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
    `Handwritten introduction.\n\n${agentsBlock({ profile: "full", ratchet: true, verificationSkill: ".agents/skills/verify-runtime/SKILL.md", glossary: "docs/GLOSSARY.md" }).trimEnd()}\n\nHandwritten footer.\n`,
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

test("sync rejects antelopejs@416e25b:.dependency-cruiser.cjs outsider exemptions in both modes and accepts the repaired boundary", (t) => {
  const root = testRepo(t);
  const config = read(
    PACKAGE_ROOT,
    "src/guardrails/fixtures/antelopejs-416e25b.txt",
  );
  put(root, ".dependency-cruiser.cjs", config);
  put(root, "src/core/cli/public.ts", "export {};\n");
  commit(root);
  for (const check of [false, true]) {
    const result = syncRepository(root, { check, profile: "template" });
    assert.match(
      result.errors.join("\n"),
      /output-entry-only exempts src\/core\/cli\/public.ts outside its module/,
    );
    assert.deepEqual(result.paths, []);
  }
  put(
    root,
    ".dependency-cruiser.cjs",
    config.replace("|src/core/cli/public\\\\.ts$", ""),
  );
  const repaired = syncRepository(root, { profile: "template" });
  assert.deepEqual(repaired.errors, []);
  assert.deepEqual(
    syncRepository(root, { check: true, profile: "template" }).errors,
    [],
  );
});

test("sync skips entry-only rules with unsupported selectors with a printed note instead of failing", (t) => {
  const root = testRepo(t);
  put(
    root,
    ".dependency-cruiser.cjs",
    `module.exports = { forbidden: [
  { name: "api-entry-only", severity: "error", from: { path: "^src/", pathNot: "^src/api/" }, to: { path: "^src/api/" } },
  { name: "db-entry-only", severity: "warn", from: { pathNot: "^src/db/" }, to: { path: "^src/db/" } },
  { name: "ui-entry-only", severity: "error", from: { pathNot: "^src/other/" }, to: {} },
  { name: "core-entry-only", severity: "error", from: { pathNot: "^src/(?:core|util)/" }, to: { path: "^src/core/" } },
] };\n`,
  );
  put(root, "src/util/helper.ts", "export {};\n");
  commit(root);
  const result = bin(root, "sync", ["--check", "--profile", "template"]);
  assert.match(
    result.stdout,
    /Note: entry-only rule api-entry-only skipped, because its selectors are not supported \(from\.path\)/,
  );
  assert.match(
    result.stdout,
    /Note: entry-only rule db-entry-only skipped, because its selectors are not supported \(severity warn\)/,
  );
  assert.match(
    result.stdout,
    /Warning: entry-only rule ui-entry-only has no to\.path/,
  );
  assert.match(
    result.stderr,
    /core-entry-only exempts src\/util\/helper\.ts outside its module/,
  );
  assert.doesNotMatch(
    result.stderr,
    /api-entry-only|db-entry-only|ui-entry-only/,
  );
});

test("sync check reports every drift without writing or measuring counts, including setup permissions", (t) => {
  const root = testRepo(t);
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({ rules: { "eslint/max-params": 123 }, oversizeFiles: {} }),
  );
  put(root, ".agents/skills/verify-runtime/SKILL.md", "Verification skill.\n");
  const before = read(root, "package.json");
  const initial = bin(root, "sync", ["--check"]);
  assert.equal(initial.status, 1);
  for (const path of MANAGED_ARTIFACTS.filter(
    ({ path }) =>
      path !== "guardrails.ratchet.json" && path !== ".github/workflows/ci.yml",
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
  chmodSync(join(root, ".agents/setup"), 0o700);
  assert.equal(bin(root, "sync", ["--check"]).status, 0);
});

test("sync keeps AGENTS prose once when AGENTS.md links to CLAUDE.md", (t) => {
  const root = testRepo(t);
  linkOxlint(root);
  put(
    root,
    "oxlint.config.ts",
    'import type {} from "@antelopejs/tooling-configs/oxc/lint";\nexport default { categories: { correctness: "off" } };\n',
  );
  put(root, "sample.ts", "export const value = 1;\n");
  put(root, "CLAUDE.md", "## Versioning\n\nBump both bounds together.\n");
  symlinkSync("CLAUDE.md", join(root, "AGENTS.md"));
  const result = bin(root, "sync");
  assert.equal(result.status, 0, result.stderr);
  const agents = read(root, "AGENTS.md");
  assert.equal(agents.split("## Versioning").length, 2);
  assert.equal(read(root, "CLAUDE.md"), "@AGENTS.md\n");
  assert.equal(bin(root, "sync", ["--check"]).status, 0);
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
    ".agents/skills/verify-template/SKILL.md",
    ".agents/skills/verify-template/package.json",
    ".claude/skills/verify-template",
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
  assert.match(read(root, "AGENTS.md"), /antelopejs-api-diff <base-ref>/);
  assert.match(read(root, "AGENTS.md"), /antelopejs-comment-proof <base-ref>/);
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
    "guardrails.suppressions.json",
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

test("sync leaves retired files for ratchet:update, then removes ratchet wiring without measuring new debt", (t) => {
  const root = testRepo(t);
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({ rules: { "eslint/no-alert": 0 }, oversizeFiles: {} }),
  );
  const first = bin(root, "sync");
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Note:.*ratchet:update/);
  assert.equal(existsSync(join(root, "guardrails.ratchet.json")), true);
  assert.match(read(root, "AGENTS.md"), /### Debt/);
  const check = bin(root, "sync", ["--check"]);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /ratchet:update/);
  rmSync(join(root, "guardrails.ratchet.json"));
  const adopted = parseManifest(read(root, "package.json"));
  assert.ok(adopted.scripts);
  adopted.scripts["sync:check"] = "";
  put(root, "package.json", JSON.stringify(adopted));
  put(root, "new-debt.ts", "export let debt: any;\n");
  const retired = bin(root, "sync");
  assert.equal(retired.status, 0, retired.stderr);
  assert.equal(existsSync(join(root, "guardrails.ratchet.json")), false);
  assert.doesNotMatch(
    read(root, "AGENTS.md"),
    /### Debt|ratchet|Existing debt only shrinks/,
  );
  assert.doesNotMatch(read(root, "lefthook.yml"), /antelopejs-ratchet/);
  const manifest = parseManifest(read(root, "package.json"));
  assert.equal(manifest.scripts?.ratchet, undefined);
  assert.equal(manifest.scripts?.["ratchet:update"], undefined);
  assert.equal(bin(root, "sync", ["--check"]).status, 0);
  assert.equal(bin(root, "sync").status, 0);
  assert.equal(existsSync(join(root, "guardrails.ratchet.json")), false);
});

test("first adoption without debt writes no ratchet file, scripts or hook, but keeps a suppression budget at today's counts", (t) => {
  const root = testRepo(t);
  linkOxlint(root);
  put(
    root,
    "oxlint.config.ts",
    'import type {} from "@antelopejs/tooling-configs/oxc/lint";\nexport default { categories: { correctness: "off" } };\n',
  );
  const result = bin(root, "sync");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(root, "guardrails.ratchet.json")), false);
  assert.equal(
    parseManifest(read(root, "package.json")).scripts?.ratchet,
    undefined,
  );
  assert.doesNotMatch(read(root, "lefthook.yml"), /antelopejs-ratchet/);
  assert.deepEqual(JSON.parse(read(root, "guardrails.suppressions.json")), {
    rules: {},
    tsExpectError: 0,
    tsIgnore: 0,
    safety: 0,
    config: { "category:correctness for *": 1 },
  });
  assert.match(read(root, "lefthook.yml"), /antelopejs-suppressions --staged/);
  assert.equal(bin(root, "sync", ["--check"]).status, 0);
});
