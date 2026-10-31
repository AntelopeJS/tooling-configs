import assert from "node:assert/strict";
import { lstatSync, readlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { bin, linkOxlint, put, read, testRepo } from "./helpers/test-repo.ts";

const SKILLS = ["technical-writing", "unslop"] as const;
const PROFILES = [[], ["--profile", "template"]] as const;

function skillPath(name: string): string {
  return `.agents/skills/${name}/SKILL.md`;
}

function linkPath(name: string): string {
  return `.claude/skills/${name}`;
}

for (const profile of PROFILES) {
  const label = profile.length ? "template" : "full";

  test(`sync installs the vendored writing skills and a Claude link for each, ${label} profile`, (t) => {
    const root = testRepo(t);
    if (!profile.length) {
      linkOxlint(root);
      put(
        root,
        "oxlint.config.ts",
        'import type {} from "@antelopejs/tooling-configs/oxc/lint";\nexport default {};\n',
      );
    }
    const result = bin(root, "sync", [...profile]);
    assert.equal(result.status, 0, result.stderr);
    for (const name of SKILLS) {
      assert.match(
        read(root, skillPath(name)),
        new RegExp(`^---\\nname: ${name}\\n`),
      );
      assert.equal(
        readlinkSync(join(root, linkPath(name))),
        `../../.agents/skills/${name}`,
      );
      assert.equal(
        read(root, `${linkPath(name)}/SKILL.md`),
        read(root, skillPath(name)),
      );
    }
    assert.match(read(root, skillPath("unslop")), /### Plain speech\n/);
    assert.match(
      read(root, skillPath("technical-writing")),
      /## Pick the mode first \(Diátaxis\)\n/,
    );
  });
}

test("--check names each missing skill file and link as drift and writes nothing", (t) => {
  const root = testRepo(t);
  const check = bin(root, "sync", ["--profile", "template", "--check"]);
  assert.equal(check.status, 1);
  for (const name of SKILLS) {
    assert.ok(
      check.stdout.includes(`Drift: ${skillPath(name)}; run antelopejs-sync\n`),
    );
    assert.ok(
      check.stdout.includes(`Drift: ${linkPath(name)}; run antelopejs-sync\n`),
    );
  }
  assert.equal(
    lstatSync(join(root, ".agents/skills"), { throwIfNoEntry: false }),
    undefined,
  );
});

test("an edited skill is drift under --check, and sync restores the vendored text", (t) => {
  const root = testRepo(t);
  assert.equal(bin(root, "sync", ["--profile", "template"]).status, 0);
  const vendored = read(root, skillPath("unslop"));
  put(root, skillPath("unslop"), "edited\n");
  const check = bin(root, "sync", ["--profile", "template", "--check"]);
  assert.equal(check.status, 1);
  assert.equal(
    check.stdout,
    `Drift: ${skillPath("unslop")}; run antelopejs-sync\n`,
  );
  assert.equal(bin(root, "sync", ["--profile", "template"]).status, 0);
  assert.equal(read(root, skillPath("unslop")), vendored);
});

test("a deleted link is drift under --check, and a real folder in its place is refused", (t) => {
  const root = testRepo(t);
  assert.equal(bin(root, "sync", ["--profile", "template"]).status, 0);
  rmSync(join(root, linkPath("unslop")));
  const check = bin(root, "sync", ["--profile", "template", "--check"]);
  assert.equal(check.status, 1);
  assert.equal(
    check.stdout,
    `Drift: ${linkPath("unslop")}; run antelopejs-sync\n`,
  );
  put(root, `${linkPath("unslop")}/SKILL.md`, "own copy\n");
  const refused = bin(root, "sync", ["--profile", "template"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /\.claude\/skills\/unslop is not a symlink/);
});

test("a check after sync is silent with the skills in place", (t) => {
  const root = testRepo(t);
  assert.equal(bin(root, "sync", ["--profile", "template"]).status, 0);
  assert.match(read(root, skillPath("unslop")), /^---\nname: unslop\n/);
  const again = bin(root, "sync", ["--profile", "template", "--check"]);
  assert.equal(again.status, 0, again.stdout);
  assert.equal(again.stdout, "Guardrails are in sync.\n");
});
