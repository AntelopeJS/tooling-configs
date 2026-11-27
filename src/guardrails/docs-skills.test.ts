import assert from "node:assert/strict";
import { lstatSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import test from "node:test";

import {
  bin,
  linkOxlint,
  markTemplateSource,
  put,
  read,
  testRepo,
} from "./helpers/test-repo.ts";

const SKILLS = ["technical-writing", "unslop"] as const;
const TEMPLATE_SOURCE = ["--profile", "template"];
const PROFILES = [[], TEMPLATE_SOURCE] as const;

function skillPath(name: string): string {
  return `.agents/skills/${name}/SKILL.md`;
}

function linkPath(name: string): string {
  return `.claude/skills/${name}`;
}

const VERIFY = "verify-changes";

/** A full-profile repository `antelopejs-sync` can sync: the pack's oxlint linked and its preset config in place. */
function fullRepo(t: Parameters<typeof testRepo>[0]): string {
  const root = testRepo(t);
  linkOxlint(root);
  put(
    root,
    "oxlint.config.ts",
    'import type {} from "@antelopejs/tooling-configs/oxc/lint";\nexport default {};\n',
  );
  return root;
}

for (const profile of PROFILES) {
  const label = profile.length ? "template" : "full";

  test(`sync installs the vendored writing skills and a Claude link for each, ${label} profile`, (t) => {
    const root = profile.length ? testRepo(t) : fullRepo(t);
    if (profile.length) markTemplateSource(root);
    const result = bin(root, "sync", [...profile]);
    assert.equal(result.status, 0, result.stderr);
    for (const name of SKILLS) {
      assert.match(
        read(root, skillPath(name)),
        new RegExp(`^---\\nname: ${name}\\n`),
      );
      const link = join(root, linkPath(name));
      assert.equal(isAbsolute(readlinkSync(link)), false);
      assert.equal(
        realpathSync(link),
        realpathSync(join(root, ".agents/skills", name)),
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
  markTemplateSource(root);
  const check = bin(root, "sync", [...TEMPLATE_SOURCE, "--check"]);
  assert.equal(check.status, 1);
  for (const name of SKILLS) {
    assert.ok(
      check.stdout.includes(`Drift: ${skillPath(name)}; run antelopejs-sync\n`),
    );
    assert.ok(
      check.stdout.includes(`Drift: ${linkPath(name)}; run antelopejs-sync\n`),
    );
  }
  for (const path of SKILLS.flatMap((name) => [
    skillPath(name),
    linkPath(name),
  ]))
    assert.equal(
      lstatSync(join(root, path), { throwIfNoEntry: false }),
      undefined,
    );
});

test("an edited skill is drift under --check, and sync restores the vendored text", (t) => {
  const root = testRepo(t);
  markTemplateSource(root);
  assert.equal(bin(root, "sync", TEMPLATE_SOURCE).status, 0);
  const vendored = read(root, skillPath("unslop"));
  put(root, skillPath("unslop"), "edited\n");
  const check = bin(root, "sync", [...TEMPLATE_SOURCE, "--check"]);
  assert.equal(check.status, 1);
  assert.equal(
    check.stdout,
    `Drift: ${skillPath("unslop")}; run antelopejs-sync\n`,
  );
  assert.equal(bin(root, "sync", TEMPLATE_SOURCE).status, 0);
  assert.equal(read(root, skillPath("unslop")), vendored);
});

test("a deleted link is drift under --check, and a real folder in its place is refused", (t) => {
  const root = testRepo(t);
  markTemplateSource(root);
  assert.equal(bin(root, "sync", TEMPLATE_SOURCE).status, 0);
  rmSync(join(root, linkPath("unslop")));
  const check = bin(root, "sync", [...TEMPLATE_SOURCE, "--check"]);
  assert.equal(check.status, 1);
  assert.equal(
    check.stdout,
    `Drift: ${linkPath("unslop")}; run antelopejs-sync\n`,
  );
  put(root, `${linkPath("unslop")}/SKILL.md`, "own copy\n");
  const refused = bin(root, "sync", TEMPLATE_SOURCE);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /\.claude\/skills\/unslop is not a symlink/);
});

test("a check after sync is silent with the skills in place", (t) => {
  const root = testRepo(t);
  markTemplateSource(root);
  assert.equal(bin(root, "sync", TEMPLATE_SOURCE).status, 0);
  assert.match(read(root, skillPath("unslop")), /^---\nname: unslop\n/);
  const again = bin(root, "sync", [...TEMPLATE_SOURCE, "--check"]);
  assert.equal(again.status, 0, again.stdout);
  assert.equal(again.stdout, "Guardrails are in sync.\n");
});

test("full-profile sync installs verify-changes, reading the repository's facts, and the Guardrails block points to it; a template source gets neither", (t) => {
  const root = fullRepo(t);
  assert.equal(bin(root, "sync").status, 0);
  const skill = read(root, `${linkPath(VERIFY)}/SKILL.md`);
  assert.match(skill, /^---\nname: verify-changes\n/);
  assert.match(skill, /`scripts` of the `package.json`/);
  assert.match(skill, /`## Tests` section/);
  assert.match(skill, /at most 4 test workers/);
  assert.match(
    read(root, "AGENTS.md"),
    /\[`verify-changes`\]\(\.agents\/skills\/verify-changes\/SKILL\.md\)/,
  );
  const template = testRepo(t);
  markTemplateSource(template);
  assert.equal(bin(template, "sync", TEMPLATE_SOURCE).status, 0);
  assert.equal(
    lstatSync(join(template, ".agents/skills", VERIFY), {
      throwIfNoEntry: false,
    }),
    undefined,
  );
});

test("a repository with its own verify-* skill gets no verify-changes, and the Guardrails block points to its skill", (t) => {
  const root = fullRepo(t);
  put(root, ".claude/skills/verify-dms/SKILL.md", "own\n");
  assert.equal(bin(root, "sync").status, 0);
  assert.equal(
    lstatSync(join(root, linkPath(VERIFY)), { throwIfNoEntry: false }),
    undefined,
  );
  const agents = read(root, "AGENTS.md");
  assert.match(
    agents,
    /\[`verify-dms`\]\(\.claude\/skills\/verify-dms\/SKILL\.md\) skill says/,
  );
  assert.doesNotMatch(agents, /verify-changes/);
  assert.equal(bin(root, "sync", ["--check"]).status, 0);
});

test("a verify-* skill added after sync retires verify-changes: --check names its files as drift, and sync removes them", (t) => {
  const root = fullRepo(t);
  assert.equal(bin(root, "sync").status, 0);
  put(root, ".agents/skills/verify-api/SKILL.md", "own\n");
  const check = bin(root, "sync", ["--check"]);
  assert.equal(check.status, 1);
  for (const path of [skillPath(VERIFY), linkPath(VERIFY)])
    assert.ok(
      check.stdout.includes(`Drift: ${path}; run antelopejs-sync\n`),
      check.stdout,
    );
  assert.equal(bin(root, "sync").status, 0);
  for (const path of [skillPath(VERIFY), linkPath(VERIFY)])
    assert.equal(
      lstatSync(join(root, path), { throwIfNoEntry: false }),
      undefined,
    );
  assert.equal(read(root, ".agents/skills/verify-api/SKILL.md"), "own\n");
  assert.equal(bin(root, "sync", ["--check"]).status, 0);
});
