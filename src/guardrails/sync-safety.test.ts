import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { AGENTS_BLOCK_START } from "./agents-block.ts";
import { managedPackage, parseManifest, toolingVersions } from "./package.ts";
import { syncRepository } from "./sync.ts";
import { bin, put, read, testRepo } from "./helpers/test-repo.ts";

const LEGACY =
  "- Explain non-obvious constraints and decisions in comments; avoid restating the code. Document public contracts with TSDoc.";

function readyRepo(t: Parameters<typeof testRepo>[0]): string {
  const root = testRepo(t);
  put(root, "guardrails.ratchet.json", '{"rules":{},"oversizeFiles":{}}\n');
  put(
    root,
    ".github/workflows/ci.yml",
    "jobs:\n  checks:\n    steps:\n      - run: pnpm run checks\n",
  );
  return root;
}

test("prepare is a silent POSIX no-op without git metadata, git, or lefthook, and installs only in a work tree", (t) => {
  const root = readyRepo(t);
  const manifest = parseManifest(
    managedPackage(read(root, "package.json"), toolingVersions()),
  );
  const prepare = manifest.scripts?.prepare;
  assert.ok(prepare);
  const detached = join(root, "detached");
  mkdirSync(detached);
  const invoke = (cwd: string, path: string) =>
    spawnSync("/bin/sh", ["-c", prepare], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PATH: path, GIT_CEILING_DIRECTORIES: root },
    });
  const empty = invoke(detached, "/nonexistent");
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout + empty.stderr, "");
  const scripts = join(root, "stub-bin");
  mkdirSync(scripts);
  put(
    root,
    "stub-bin/lefthook",
    '#!/bin/sh\nprintf "%s\\n" "$*" > installed\n',
  );
  chmodSync(join(scripts, "lefthook"), 0o755);
  const noGit = invoke(root, scripts);
  assert.equal(noGit.status, 0, noGit.stderr);
  assert.equal(existsSync(join(root, "installed")), false);
  const noRepo = invoke(detached, `${scripts}:/usr/bin:/bin`);
  assert.equal(noRepo.status, 0, noRepo.stderr);
  assert.equal(existsSync(join(detached, "installed")), false);
  const gitOnly = join(root, "git-only");
  mkdirSync(gitOnly);
  symlinkSync(
    execFileSync("which", ["git"], { encoding: "utf8" }).trim(),
    join(gitOnly, "git"),
  );
  assert.equal(invoke(root, gitOnly).status, 0);
  const installed = invoke(root, `${scripts}:/usr/bin:/bin`);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(read(root, "installed"), "install\n");
  put(
    root,
    "package.json",
    JSON.stringify({ scripts: { prepare: "printf existing" } }),
  );
  const existing = parseManifest(
    managedPackage(read(root, "package.json"), toolingVersions()),
  );
  assert.match(existing.scripts?.prepare ?? "", /^printf existing && /);
});

test("prepare preserves a command mentioning lefthook and upgrades the previous managed install", (t) => {
  const root = readyRepo(t);
  put(
    root,
    "package.json",
    '{"scripts":{"prepare":"echo lefthook install"}}\n',
  );
  const mention = parseManifest(
    managedPackage(read(root, "package.json"), toolingVersions()),
  );
  assert.match(
    mention.scripts?.prepare ?? "",
    /^echo lefthook install && if git /,
  );
  put(
    root,
    "package.json",
    '{"scripts":{"prepare":"printf existing && pnpm exec lefthook install"}}\n',
  );
  const upgraded = parseManifest(
    managedPackage(read(root, "package.json"), toolingVersions()),
  );
  assert.match(upgraded.scripts?.prepare ?? "", /^printf existing && if git /);
  assert.doesNotMatch(upgraded.scripts?.prepare ?? "", /pnpm exec/);
});

for (const [file, target, specifier] of [
  [
    ".oxlintrc.json",
    "oxlint.config.ts",
    "@antelopejs/tooling-configs/oxc/lint",
  ],
  [".oxfmtrc.json", "oxfmt.config.ts", "@antelopejs/tooling-configs/oxc/fmt"],
  ["knip.json", "knip.config.ts", "@antelopejs/tooling-configs/knip"],
  ["knip.jsonc", "knip.config.ts", "@antelopejs/tooling-configs/knip"],
  [".knip.json", "knip.config.ts", "@antelopejs/tooling-configs/knip"],
]) {
  test(`sync blocks ${file} before any write and explains the migration in normal and check mode`, (t) => {
    const root = readyRepo(t);
    put(root, file, "{}\n");
    const before = read(root, "package.json");
    for (const args of [[], ["--check"]]) {
      const result = bin(root, "sync", args);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.ok(result.stderr.includes(file), result.stderr);
      assert.ok(result.stderr.includes(target), result.stderr);
      assert.ok(result.stderr.includes(specifier), result.stderr);
      assert.match(result.stderr, /[Dd]elete.*rerun/);
      assert.equal(read(root, "package.json"), before);
      assert.equal(existsSync(join(root, "AGENTS.md")), false);
    }
  });
}

for (const [file, specifier] of [
  ["oxlint.config.ts", "@antelopejs/tooling-configs/oxc/lint"],
  ["oxfmt.config.ts", "@antelopejs/tooling-configs/oxc/fmt"],
  ["knip.config.ts", "@antelopejs/tooling-configs/knip"],
]) {
  test(`sync never replaces an unrecognized ${file}`, (t) => {
    const root = readyRepo(t);
    put(root, file, "export default { custom: true };\n");
    for (const args of [[], ["--check"]]) {
      const result = bin(root, "sync", args);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(file), result.stderr);
      assert.ok(result.stderr.includes(specifier), result.stderr);
      assert.equal(read(root, file), "export default { custom: true };\n");
      assert.equal(existsSync(join(root, "lefthook.yml")), false);
    }
  });
}

test("lefthook merges managed commands without losing other commands, hooks, options, or key order", (t) => {
  const root = readyRepo(t);
  put(
    root,
    "lefthook.yml",
    "commit-msg:\n  commands:\n    subject:\n      run: check-subject {1}\npre-commit:\n  parallel: true\n  commands:\n    custom:\n      run: echo custom\npre-push:\n  commands:\n    integration:\n      run: npm test\n",
  );
  const first = bin(root, "sync");
  assert.equal(first.status, 0, first.stderr);
  const merged = read(root, "lefthook.yml");
  assert.match(merged, /run: check-subject \{1\}/);
  assert.match(merged, /parallel: true/);
  assert.match(merged, /run: echo custom/);
  assert.match(merged, /run: npm test/);
  assert.match(merged, /antelopejs-ratchet:[\s\S]*antelopejs-ratchet --staged/);
  assert.match(merged, /antelopejs-check-size --staged/);
  assert.ok(merged.indexOf("commit-msg:") < merged.indexOf("pre-commit:"));
  assert.equal(bin(root, "sync").status, 0);
  assert.equal(read(root, "lefthook.yml"), merged);
});

test("sync migrates CLAUDE prose into handwritten AGENTS and removes only the exact legacy comment instruction", (t) => {
  const root = readyRepo(t);
  put(
    root,
    "AGENTS.md",
    `# Project\n\nKeep me.\n${LEGACY}\nA related instruction stays.\n`,
  );
  put(root, "CLAUDE.md", "# Additional guidance\n\nPreserve this contract.\n");
  const result = bin(root, "sync");
  assert.equal(result.status, 0, result.stderr);
  const agents = read(root, "AGENTS.md");
  assert.match(agents, /Keep me/);
  assert.match(agents, /A related instruction stays/);
  assert.doesNotMatch(agents, /Explain non-obvious constraints/);
  assert.ok(
    agents.indexOf("Preserve this contract") <
      agents.indexOf(AGENTS_BLOCK_START),
  );
  assert.equal(read(root, "CLAUDE.md"), "@AGENTS.md\n");
  assert.match(result.stdout, /Note:.*CLAUDE.md.*AGENTS.md/);
  assert.match(result.stdout, /Note:.*legacy.*AGENTS.md/);
  const second = bin(root, "sync");
  assert.equal(second.status, 0, second.stderr);
  assert.equal(read(root, "AGENTS.md"), agents);
  assert.doesNotMatch(second.stdout, /Note:/);
});

test("sync recognizes the consumer's single-line CLAUDE pointer without copying it", (t) => {
  const root = readyRepo(t);
  put(
    root,
    "CLAUDE.md",
    "See [AGENTS.md](./AGENTS.md) for code conventions and guidelines.\n",
  );
  assert.equal(bin(root, "sync").status, 0);
  assert.equal(read(root, "CLAUDE.md"), "@AGENTS.md\n");
  assert.doesNotMatch(read(root, "AGENTS.md"), /See \[AGENTS.md\]/);
});

test("missing checks CI is a note on sync and a failure on check; real run and reusable uses are accepted", (t) => {
  const root = testRepo(t, false);
  put(root, "guardrails.ratchet.json", '{"rules":{},"oversizeFiles":{}}\n');
  const sync = bin(root, "sync");
  assert.equal(sync.status, 0, sync.stderr);
  assert.match(sync.stdout, /Note:.*workflow.*pnpm run checks/);
  const check = bin(root, "sync", ["--check"]);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /workflow.*pnpm run checks/);
  put(
    root,
    ".github/workflows/ci.yaml",
    'jobs:\n  ci:\n    steps:\n      - run: echo "pnpm run checks"\n',
  );
  assert.equal(bin(root, "sync", ["--check"]).status, 1);
  for (const command of ["pnpm run checks", "pnpm checks"]) {
    put(
      root,
      ".github/workflows/ci.yaml",
      `jobs:\n  ci:\n    steps:\n      - run: |\n          pnpm install\n          ${command}\n`,
    );
    assert.equal(bin(root, "sync", ["--check"]).status, 0);
  }
  put(
    root,
    ".github/workflows/ci.yaml",
    "jobs:\n  ci:\n    uses: AntelopeJS/.github/.github/workflows/ci-node.yml@v1\n",
  );
  assert.equal(bin(root, "sync", ["--check"]).status, 0);
});

test("type-aware configs install the matching tsgolint version and Nuxt gets its own default typecheck", (t) => {
  const root = readyRepo(t);
  put(root, "nuxt.config.ts", "export default {};\n");
  assert.equal(bin(root, "sync").status, 0);
  const manifest = parseManifest(read(root, "package.json"));
  assert.equal(manifest.scripts?.typecheck, "nuxi typecheck");
  const own = parseManifest(read(process.cwd(), "package.json"));
  assert.ok(own.devDependencies?.["oxlint-tsgolint"]);
  assert.equal(
    manifest.devDependencies?.["oxlint-tsgolint"],
    own.devDependencies?.["oxlint-tsgolint"],
  );
  const other = readyRepo(t);
  put(other, "package.json", '{"dependencies":{"nuxt":"^4.0.0"}}\n');
  assert.equal(bin(other, "sync").status, 0);
  assert.equal(
    parseManifest(read(other, "package.json")).scripts?.typecheck,
    "nuxi typecheck",
  );
});

test("self sync accepts source presets and runs source bins before a build", (t) => {
  const root = readyRepo(t);
  put(root, "package.json", '{"name":"@antelopejs/tooling-configs"}\n');
  put(
    root,
    "oxlint.config.ts",
    'import { antelopePreset } from "./src/oxc/lint.ts";\nexport default antelopePreset({ typeAware: false });\n',
  );
  const result = syncRepository(root);
  assert.ok(result.paths.includes("package.json"));
  assert.match(read(root, "oxlint.config.ts"), /typeAware: false/);
  const manifest = parseManifest(read(root, "package.json"));
  assert.equal(manifest.scripts?.checks, "node src/bin/checks.ts");
  assert.equal(
    manifest.scripts?.["sync:check"],
    "node src/bin/sync.ts --check",
  );
  assert.equal(bin(root, "sync", ["--check"]).status, 0);
});

test("type-aware oxlint adds tsgolint for both generated and existing configs, but not when disabled", (t) => {
  for (const config of [
    undefined,
    'import type {} from "@antelopejs/tooling-configs/oxc/lint";\nexport default { options: { "typeAware": true } };\n',
  ]) {
    const root = readyRepo(t);
    if (config) put(root, "oxlint.config.ts", config);
    assert.equal(bin(root, "sync").status, 0);
    assert.match(
      parseManifest(read(root, "package.json")).devDependencies?.[
        "oxlint-tsgolint"
      ] ?? "",
      /\d+\.\d+\.\d+/,
    );
  }
  const root = readyRepo(t);
  put(
    root,
    "oxlint.config.ts",
    'import type {} from "@antelopejs/tooling-configs/oxc/lint";\nexport default { options: { typeAware: false } };\n',
  );
  assert.equal(bin(root, "sync").status, 0);
  assert.equal(
    parseManifest(read(root, "package.json")).devDependencies?.[
      "oxlint-tsgolint"
    ],
    undefined,
  );
});

test("invalid hook mappings block the complete sync plan without losing files", (t) => {
  for (const content of [
    "not a mapping\n",
    "pre-commit:\n  commands: [one, two]\n",
    "pre-push: [broken\n",
  ]) {
    const root = readyRepo(t);
    put(root, "lefthook.yml", content);
    const before = read(root, "package.json");
    for (const args of [[], ["--check"]]) {
      const result = bin(root, "sync", args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /lefthook.yml/);
      assert.equal(read(root, "lefthook.yml"), content);
      assert.equal(read(root, "package.json"), before);
      assert.equal(existsSync(join(root, "AGENTS.md")), false);
    }
  }
});
