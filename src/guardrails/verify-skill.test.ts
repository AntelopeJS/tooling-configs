import assert from "node:assert/strict";
import { existsSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  claudeLink,
  skillFolder,
  VERIFY_KINDS,
  type VerifyKind,
} from "../verify/kinds.ts";
import { skillText, syncedFiles } from "../verify/skills.ts";
import type { Manifest } from "./package.ts";
import { bin, put, read, testRepo } from "./helpers/test-repo.ts";

const TEMPLATE = ["--profile", "template"];
const IN_SYNC = "Guardrails are in sync.\n";
const OWN_SKILL = ".agents/skills/verify-repo/SKILL.md";
const OWNED = {
  "features/x.md": "# Feature\r\nno final newline",
  "verify.config.ts": "export default { runs: 2 };\n",
  "seeded-breaks/x.patch": "--- a\n+++ b\n",
  "seeded-doors/data.patch": "door\u0000bytes\n",
  "fixtures/f.json": '{"a":1}',
} as const;

function skillPath(kind: VerifyKind): string {
  return `${skillFolder(kind)}/SKILL.md`;
}

function syncedRepo(t: TestContext, kind: VerifyKind): string {
  const root = testRepo(t);
  const result = bin(root, "sync", [...TEMPLATE, "--verify", kind]);
  assert.equal(result.status, 0, result.stderr);
  return root;
}

function putOwned(root: string, kind: VerifyKind): void {
  for (const [path, content] of Object.entries(OWNED))
    put(root, `${skillFolder(kind)}/${path}`, content);
}

function ownedFiles(root: string, kind: VerifyKind): string[] {
  return Object.keys(OWNED).map((path) =>
    read(root, `${skillFolder(kind)}/${path}`),
  );
}

function hasLayer(root: string, kind: VerifyKind): boolean {
  return (
    existsSync(join(root, skillPath(kind))) ||
    existsSync(join(root, claudeLink(kind)))
  );
}

function withPackage(
  root: string,
  fields: Pick<Manifest, "name" | "antelopeJs">,
): void {
  put(
    root,
    "package.json",
    JSON.stringify({ name: "repo", type: "module", ...fields }),
  );
}

test("--verify module writes the skill text and a relative link that survives moving the repository, and the next check is silent", (t) => {
  const root = syncedRepo(t, "module");
  assert.equal(read(root, skillPath("module")), skillText("module"));
  assert.equal(
    read(root, `${claudeLink("module")}/SKILL.md`),
    skillText("module"),
  );
  const check = bin(root, "sync", [...TEMPLATE, "--check"]);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.stdout, IN_SYNC);
  const moved = `${root}-moved`;
  t.after(() => rmSync(moved, { recursive: true, force: true }));
  renameSync(root, moved);
  assert.equal(
    read(moved, `${claudeLink("module")}/SKILL.md`),
    skillText("module"),
  );
});

test("--check reports both missing synced paths as drift and writes nothing", (t) => {
  const root = testRepo(t);
  const result = bin(root, "sync", [
    ...TEMPLATE,
    "--verify",
    "module",
    "--check",
  ]);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /Drift: \.agents\/skills\/verify-module\/SKILL\.md; run antelopejs-sync\n/,
  );
  assert.match(
    result.stdout,
    /Drift: \.claude\/skills\/verify-module; run antelopejs-sync\n/,
  );
  assert.equal(hasLayer(root, "module"), false);
});

test("an edited SKILL.md or skill package.json is drift under --check and sync restores both", (t) => {
  const root = syncedRepo(t, "module");
  const synced = syncedFiles("module");
  for (const { path } of synced) put(root, path, "edited\n");
  const check = bin(root, "sync", [...TEMPLATE, "--check"]);
  assert.equal(check.status, 1);
  assert.equal(
    check.stdout,
    synced.map(({ path }) => `Drift: ${path}; run antelopejs-sync\n`).join(""),
  );
  assert.equal(read(root, skillPath("module")), "edited\n");
  assert.equal(bin(root, "sync", TEMPLATE).status, 0);
  for (const { path, content } of synced)
    assert.equal(read(root, path), content);
});

test("a deleted or retargeted link is drift under --check and sync restores it", (t) => {
  const root = syncedRepo(t, "module");
  const link = join(root, claudeLink("module"));
  rmSync(link);
  const missing = bin(root, "sync", [...TEMPLATE, "--check"]);
  assert.equal(missing.status, 1);
  assert.equal(
    missing.stdout,
    `Drift: ${claudeLink("module")}; run antelopejs-sync\n`,
  );
  symlinkSync("../../.agents/skills/elsewhere", link);
  const wrong = bin(root, "sync", [...TEMPLATE, "--check"]);
  assert.equal(wrong.status, 1);
  assert.equal(
    wrong.stdout,
    `Drift: ${claudeLink("module")}; run antelopejs-sync\n`,
  );
  assert.equal(bin(root, "sync", TEMPLATE).status, 0);
  assert.equal(
    read(root, `${claudeLink("module")}/SKILL.md`),
    skillText("module"),
  );
});

test("repo-owned files stay byte-identical across sync, a kind change and --verify custom", (t) => {
  const root = syncedRepo(t, "module");
  putOwned(root, "module");
  const expected = Object.values(OWNED);
  assert.equal(bin(root, "sync", TEMPLATE).status, 0);
  assert.deepEqual(ownedFiles(root, "module"), expected);
  const preview = bin(root, "sync", [
    ...TEMPLATE,
    "--verify",
    "interface",
    "--check",
  ]);
  assert.equal(preview.status, 1);
  for (const path of [
    skillPath("interface"),
    claudeLink("interface"),
    skillPath("module"),
    claudeLink("module"),
  ])
    assert.match(preview.stdout, new RegExp(`Drift: ${path}; run`));
  assert.equal(hasLayer(root, "interface"), false);
  const changed = bin(root, "sync", [...TEMPLATE, "--verify", "interface"]);
  assert.equal(changed.status, 0, changed.stderr);
  assert.match(changed.stdout, /Note: .*verify-module.*Kept.*repo-owned/);
  assert.equal(hasLayer(root, "module"), false);
  assert.equal(read(root, skillPath("interface")), skillText("interface"));
  assert.deepEqual(ownedFiles(root, "module"), expected);
  putOwned(root, "interface");
  put(root, OWN_SKILL, "Own verification skill.\n");
  const custom = bin(root, "sync", [...TEMPLATE, "--verify", "custom"]);
  assert.equal(custom.status, 0, custom.stderr);
  assert.match(custom.stdout, /Note: .*verify-interface.*Kept.*repo-owned/);
  assert.equal(hasLayer(root, "interface"), false);
  assert.deepEqual(ownedFiles(root, "interface"), expected);
  assert.deepEqual(ownedFiles(root, "module"), expected);
  assert.equal(read(root, OWN_SKILL), "Own verification skill.\n");
  const after = bin(root, "sync", [...TEMPLATE, "--check"]);
  assert.equal(after.status, 0, after.stderr);
  assert.equal(after.stdout, IN_SYNC);
});

test("--verify custom fails without an own skill and keeps a shared layer, which never counts as own", (t) => {
  const bare = testRepo(t);
  put(bare, ".agents/skills/runtime/SKILL.md", "Not a verification name.\n");
  const missing = bin(bare, "sync", [...TEMPLATE, "--verify", "custom"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /\.agents\/skills\/verify-<repo>\//);
  assert.equal(existsSync(join(bare, "AGENTS.md")), false);
  const root = syncedRepo(t, "module");
  putOwned(root, "module");
  const shared = bin(root, "sync", [...TEMPLATE, "--verify", "custom"]);
  assert.equal(shared.status, 1);
  assert.match(shared.stderr, /verify-<repo>/);
  assert.equal(read(root, skillPath("module")), skillText("module"));
  assert.equal(hasLayer(root, "module"), true);
  const check = bin(root, "sync", [
    ...TEMPLATE,
    "--verify",
    "custom",
    "--check",
  ]);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /verify-<repo>/);
});

test("the template profile infers the template kind", (t) => {
  const root = testRepo(t);
  const result = bin(root, "sync", TEMPLATE);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /No verification skill/);
  assert.equal(read(root, skillPath("template")), skillText("template"));
  assert.equal(
    read(root, `${claudeLink("template")}/SKILL.md`),
    skillText("template"),
  );
});

test("antelopeJs.implements infers module and antelopeJs.kind wins over it", (t) => {
  const implementing = testRepo(t);
  withPackage(implementing, { antelopeJs: { implements: ["logging"] } });
  const first = bin(implementing, "sync", ["--check"]);
  assert.match(
    first.stdout,
    /Drift: \.agents\/skills\/verify-module\/SKILL\.md/,
  );
  assert.match(first.stdout, /Drift: \.claude\/skills\/verify-module;/);
  assert.doesNotMatch(first.stdout, /verify-(?:interface|template)/);
  const declared = testRepo(t);
  withPackage(declared, {
    antelopeJs: { kind: "interface", implements: ["logging"] },
  });
  const second = bin(declared, "sync", ["--check"]);
  assert.match(
    second.stdout,
    /Drift: \.agents\/skills\/verify-interface\/SKILL\.md/,
  );
  assert.doesNotMatch(second.stdout, /verify-(?:module|template)/);
});

test("without a signal sync writes nothing and stays quiet, whatever the package name says", (t) => {
  const root = testRepo(t);
  put(
    root,
    "guardrails.ratchet.json",
    '{"rules":{"eslint/no-alert":1},"oversizeFiles":{}}\n',
  );
  withPackage(root, {
    name: "logging-interface",
    antelopeJs: { implements: [] },
  });
  const sync = bin(root, "sync", ["--profile", "full"]);
  assert.equal(sync.status, 0, sync.stderr);
  assert.doesNotMatch(sync.stdout, /verif/i);
  for (const kind of VERIFY_KINDS) assert.equal(hasLayer(root, kind), false);
  const check = bin(root, "sync", ["--check"]);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.stdout, IN_SYNC);
});

test("an own verification skill beats the template profile and the package kind, and sync writes no shared layer", (t) => {
  const root = testRepo(t);
  withPackage(root, { antelopeJs: { kind: "module" } });
  put(root, OWN_SKILL, "Own verification skill.\n");
  const result = bin(root, "sync", TEMPLATE);
  assert.equal(result.status, 0, result.stderr);
  for (const kind of VERIFY_KINDS) assert.equal(hasLayer(root, kind), false);
  assert.match(
    read(root, "AGENTS.md"),
    /\.agents\/skills\/verify-repo\/SKILL\.md/,
  );
  const check = bin(root, "sync", [...TEMPLATE, "--check"]);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.stdout, IN_SYNC);
});

test("an existing shared SKILL.md fixes the kind over the package signal", (t) => {
  const root = syncedRepo(t, "interface");
  withPackage(root, { antelopeJs: { implements: ["logging"] } });
  put(root, skillPath("interface"), "edited\n");
  const result = bin(root, "sync", TEMPLATE);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(read(root, skillPath("interface")), skillText("interface"));
  assert.equal(hasLayer(root, "module"), false);
});

test("two shared SKILL.md files are an error naming both, and --verify picks one", (t) => {
  const root = syncedRepo(t, "module");
  put(root, skillPath("interface"), "Hand copied.\n");
  const check = bin(root, "sync", [...TEMPLATE, "--check"]);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /verify-interface\/SKILL\.md/);
  assert.match(check.stderr, /verify-module\/SKILL\.md/);
  const sync = bin(root, "sync", TEMPLATE);
  assert.equal(sync.status, 1);
  assert.equal(read(root, skillPath("interface")), "Hand copied.\n");
  assert.equal(read(root, skillPath("module")), skillText("module"));
  const chosen = bin(root, "sync", [...TEMPLATE, "--verify", "module"]);
  assert.equal(chosen.status, 0, chosen.stderr);
  assert.equal(hasLayer(root, "interface"), false);
});

test("an invalid --verify value is an error in both modes and writes nothing", (t) => {
  const root = testRepo(t);
  for (const args of [[], ["--check"]]) {
    const result = bin(root, "sync", [
      ...TEMPLATE,
      "--verify",
      "service",
      ...args,
    ]);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /--verify must be interface, module, template, or custom/,
    );
  }
  assert.equal(existsSync(join(root, "AGENTS.md")), false);
  for (const kind of VERIFY_KINDS) assert.equal(hasLayer(root, kind), false);
});

test("a real file or folder at the link path is an error and nothing is written", (t) => {
  for (const real of ["file", "folder"]) {
    const root = testRepo(t);
    put(
      root,
      real === "file"
        ? claudeLink("module")
        : `${claudeLink("module")}/note.md`,
      "Mine.\n",
    );
    const result = bin(root, "sync", [...TEMPLATE, "--verify", "module"]);
    assert.equal(result.status, 1, real);
    assert.match(result.stderr, /\.claude\/skills\/verify-module.*Move/, real);
    assert.equal(existsSync(join(root, skillPath("module"))), false, real);
    assert.equal(existsSync(join(root, "AGENTS.md")), false, real);
  }
});

test("the AGENTS.md block names the shared skill on the first sync", (t) => {
  const root = syncedRepo(t, "module");
  assert.match(
    read(root, "AGENTS.md"),
    /\[`\.agents\/skills\/verify-module\/SKILL\.md`\]\(\.agents\/skills\/verify-module\/SKILL\.md\)/,
  );
  const check = bin(root, "sync", [...TEMPLATE, "--check"]);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.stdout, IN_SYNC);
});
