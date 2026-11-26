import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";

import { parse } from "yaml";

import { DECLARED_PACKAGES, parseManifest } from "./package.ts";
import { installScripts } from "./helpers/install-scripts.ts";
import { bin, put, read, testRepo } from "./helpers/test-repo.ts";

function pinnedRepo(t: TestContext, packageManager: string): string {
  const root = testRepo(t);
  const manifest = parseManifest(read(root, "package.json"));
  put(
    root,
    "package.json",
    `${JSON.stringify({ ...manifest, packageManager }, null, 2)}\n`,
  );
  return root;
}

/** The release age sync writes, so pnpm installs no release published less than a day ago except AntelopeJS's own. */
const RELEASE_AGE = {
  minimumReleaseAge: 1440,
  minimumReleaseAgeExclude: ["@antelopejs/*"],
};
const RELEASE_AGE_YAML =
  'minimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - "@antelopejs/*"\n';

function synced(root: string): void {
  const result = bin(root, "sync");
  assert.equal(result.status, 0, result.stderr + result.stdout);
}

for (const pin of ["pnpm@10.17.0", "pnpm@11.27.1"])
  test(`sync tells ${pin} not to build lefthook, to install no release published less than a day ago and to install an AntelopeJS release the day it is published, then reports no drift, where a sync that writes no allowBuilds leaves every pnpm 11 install failing with ERR_PNPM_IGNORED_BUILDS, one that writes no minimumReleaseAge lets pnpm 10 install a release the day it is published and one that writes no minimumReleaseAgeExclude holds back AntelopeJS releases`, (t) => {
    const root = pinnedRepo(t, pin);
    synced(root);
    assert.deepEqual(parse(read(root, "pnpm-workspace.yaml")), {
      allowBuilds: { lefthook: false },
      ...RELEASE_AGE,
    });
    const check = bin(root, "sync", ["--check"]);
    assert.equal(check.status, 0, check.stdout + check.stderr);
  });

test("sync keeps a repository's own pnpm-workspace.yaml settings and leaves a file that decides lefthook and sets a longer release age byte for byte, where a sync that rewrites it drops its packages, forces lefthook back to false, lowers the age, fights oxfmt over its formatting or asks a pnpm 11 pin below 11.27.1 to rise over a file that holds the repository's own settings", (t) => {
  const root = pinnedRepo(t, "pnpm@11.0.0");
  put(
    root,
    "pnpm-workspace.yaml",
    "packages:\n  - packages/*\nallowBuilds:\n  esbuild: true\n",
  );
  synced(root);
  assert.deepEqual(parse(read(root, "pnpm-workspace.yaml")), {
    packages: ["packages/*"],
    allowBuilds: { esbuild: true, lefthook: false },
    ...RELEASE_AGE,
  });
  const decided =
    'packages: ["packages/*"]\nallowBuilds:\n    lefthook: true\nminimumReleaseAge: 2880\nminimumReleaseAgeExclude: ["@antelopejs/*"]\n';
  put(root, "pnpm-workspace.yaml", decided);
  synced(root);
  assert.equal(read(root, "pnpm-workspace.yaml"), decided);
});

test("sync tells pnpm 11 not to build the capture peer mongodb-memory-server in a repository with docs/captures.ts and keeps each build the repository already decides, where a sync that decides lefthook alone or overwrites a decided build leaves that install failing with ERR_PNPM_IGNORED_BUILDS", (t) => {
  const root = pinnedRepo(t, "pnpm@11.27.1");
  put(root, "docs/captures.ts", "export default [];\n");
  synced(root);
  assert.deepEqual(parse(read(root, "pnpm-workspace.yaml")), {
    allowBuilds: { lefthook: false, "mongodb-memory-server": false },
    ...RELEASE_AGE,
  });
  const check = bin(root, "sync", ["--check"]);
  assert.equal(check.status, 0, check.stdout + check.stderr);
  const decided = `allowBuilds:\n  lefthook: false\n  mongodb-memory-server: true\n${RELEASE_AGE_YAML}`;
  put(root, "pnpm-workspace.yaml", decided);
  synced(root);
  assert.equal(read(root, "pnpm-workspace.yaml"), decided);
  put(root, "pnpm-workspace.yaml", "allowBuilds:\n  lefthook: true\n");
  synced(root);
  assert.deepEqual(parse(read(root, "pnpm-workspace.yaml")), {
    allowBuilds: { lefthook: true, "mongodb-memory-server": false },
    ...RELEASE_AGE,
  });
});

for (const [current, written] of [
  ["---\n", `---\nallowBuilds:\n  lefthook: false\n${RELEASE_AGE_YAML}`],
  [
    "\n\n# settings\n",
    `# settings\nallowBuilds:\n  lefthook: false\n${RELEASE_AGE_YAML}`,
  ],
  [
    'packages: ["a"]\nallowBuilds: {}\n',
    `packages: ["a"]\nallowBuilds:\n  lefthook: false\n${RELEASE_AGE_YAML}`,
  ],
  [
    "allowBuilds:\n  lefthook:\n",
    `allowBuilds:\n  lefthook: false\n${RELEASE_AGE_YAML}`,
  ],
  [
    'minimumReleaseAgeExclude: ["left-pad"]\n',
    `minimumReleaseAgeExclude:\n  - "left-pad"\n  - "@antelopejs/*"\nallowBuilds:\n  lefthook: false\nminimumReleaseAge: 1440\n`,
  ],
])
  test(`sync writes ${JSON.stringify(current)} as oxfmt leaves it, where a sync that pads flow maps, keeps leading blank lines, rejects a bare document marker or counts a null lefthook as decided fails format:check or the install`, (t) => {
    const root = pinnedRepo(t, "pnpm@11.27.1");
    put(root, "pnpm-workspace.yaml", current);
    synced(root);
    assert.equal(read(root, "pnpm-workspace.yaml"), written);
  });

for (const current of ["", "# workspace settings\n", "allowBuilds:\n"])
  test(`sync completes a pnpm-workspace.yaml that pnpm accepts as ${JSON.stringify(current)}, where a sync that demands a mapping exits 1 on it`, (t) => {
    const root = pinnedRepo(t, "pnpm@11.27.1");
    put(root, "pnpm-workspace.yaml", current);
    synced(root);
    assert.deepEqual(parse(read(root, "pnpm-workspace.yaml")), {
      allowBuilds: { lefthook: false },
      ...RELEASE_AGE,
    });
  });

test("sync writes no pnpm-workspace.yaml for npm@11.0.0, where a sync that writes it anyway leaves an npm repository a stray file", (t) => {
  const root = pinnedRepo(t, "npm@11.0.0");
  synced(root);
  assert.equal(existsSync(join(root, "pnpm-workspace.yaml")), false);
});

for (const [pin, current] of [
  ["pnpm@10.2.0+sha512.abc", undefined],
  ["pnpm@10.16.1", undefined],
  ["pnpm@10.6.5", `overrides:\n  foo: 1.0.0\n${RELEASE_AGE_YAML}`],
] as const)
  test(`sync asks ${pin} to rise to pnpm 10.17.0 and leaves pnpm-workspace.yaml ${current === undefined ? "absent" : "as it is"}, where a sync that writes the file anyway leaves a pnpm that installs a release the day it is published, whatever minimumReleaseAge says`, (t) => {
    const root = pinnedRepo(t, pin);
    if (current !== undefined) put(root, "pnpm-workspace.yaml", current);
    const result = bin(root, "sync");
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /`pnpm@10\.17\.0` or later/);
    assert.equal(
      existsSync(join(root, "pnpm-workspace.yaml")) &&
        read(root, "pnpm-workspace.yaml"),
      current ?? false,
    );
  });

for (const current of [undefined, "allowBuilds:\n  lefthook: false\n"])
  test(`sync asks a repository that pins pnpm 11 before 11.27.1 to raise its pin when its pnpm-workspace.yaml is ${JSON.stringify(current ?? "absent")}, where a sync that writes or keeps that file makes that pnpm install a nested project into the repository root and a sync that skips it leaves the install failing with ERR_PNPM_IGNORED_BUILDS`, (t) => {
    const root = pinnedRepo(t, "pnpm@11.27.0");
    if (current !== undefined) put(root, "pnpm-workspace.yaml", current);
    const result = bin(root, "sync", ["--check"]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /pnpm@11\.27\.1/);
    assert.equal(
      existsSync(join(root, "pnpm-workspace.yaml")),
      current !== undefined,
    );
  });

test("sync appends the release-age exclusion to a file that already decides its builds and keeps every other byte, where a sync that reserializes the file strips the padding oxfmt keeps in a flow map and fails format:check", (t) => {
  const root = pinnedRepo(t, "pnpm@11.27.1");
  const own = "overrides: { foo: 1.0.0 }\nallowBuilds:\n  lefthook: false\n";
  put(root, "pnpm-workspace.yaml", own);
  synced(root);
  assert.equal(read(root, "pnpm-workspace.yaml"), `${own}${RELEASE_AGE_YAML}`);
});

test("sync adds @antelopejs/* beside another @antelopejs entry in minimumReleaseAgeExclude, where a sync that counts any @antelopejs entry as the pattern leaves an install waiting a day for an AntelopeJS release", (t) => {
  const root = pinnedRepo(t, "pnpm@11.27.1");
  put(
    root,
    "pnpm-workspace.yaml",
    'allowBuilds:\n  lefthook: false\nminimumReleaseAgeExclude: ["@antelopejs/other"]\n',
  );
  synced(root);
  assert.deepEqual(parse(read(root, "pnpm-workspace.yaml")), {
    allowBuilds: { lefthook: false },
    minimumReleaseAge: 1440,
    minimumReleaseAgeExclude: ["@antelopejs/other", "@antelopejs/*"],
  });
});

test("sync puts @antelopejs/* in place of the @antelopejs/interface-* it listed before and keeps the repository's own entries, where a sync that appends beside it leaves a narrower duplicate and one that rewrites the list drops left-pad", (t) => {
  const root = pinnedRepo(t, "pnpm@10.33.0");
  put(
    root,
    "pnpm-workspace.yaml",
    `allowBuilds:\n  lefthook: false\nminimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - left-pad\n  - "@antelopejs/interface-*"\n`,
  );
  synced(root);
  assert.equal(
    read(root, "pnpm-workspace.yaml"),
    `allowBuilds:\n  lefthook: false\nminimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - left-pad\n  - "@antelopejs/*"\n`,
  );
});

test("sync raises a minimumReleaseAge below one day to 1440, where a sync that keeps any value it finds leaves a one-hour age that lets a broken release in", (t) => {
  const root = pinnedRepo(t, "pnpm@10.33.0");
  put(
    root,
    "pnpm-workspace.yaml",
    `allowBuilds:\n  lefthook: false\nminimumReleaseAge: 60\nminimumReleaseAgeExclude:\n  - "@antelopejs/*"\n`,
  );
  synced(root);
  assert.deepEqual(parse(read(root, "pnpm-workspace.yaml")), {
    allowBuilds: { lefthook: false },
    ...RELEASE_AGE,
  });
});

test("sync fails on a minimumReleaseAge that is not a number and leaves the file as it is, where a sync that overwrites it drops a value the repository wrote by mistake without telling it", (t) => {
  const root = pinnedRepo(t, "pnpm@10.33.0");
  const own = `allowBuilds:\n  lefthook: false\nminimumReleaseAge: one-day\n`;
  put(root, "pnpm-workspace.yaml", own);
  const result = bin(root, "sync");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stdout + result.stderr,
    /minimumReleaseAge must be a number of minutes/,
  );
  assert.equal(read(root, "pnpm-workspace.yaml"), own);
});

test("sync fails on a minimumReleaseAgeExclude that is not a list and leaves the file as it is, where a sync that skips it leaves pnpm 11 locking two copies of an interface released less than a day ago", (t) => {
  const root = pinnedRepo(t, "pnpm@11.27.1");
  const own =
    "allowBuilds:\n  lefthook: false\nminimumReleaseAgeExclude: foo\n";
  put(root, "pnpm-workspace.yaml", own);
  const result = bin(root, "sync");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stdout + result.stderr,
    /minimumReleaseAgeExclude must be a list/,
  );
  assert.equal(read(root, "pnpm-workspace.yaml"), own);
});

test("a declared package marked build none has no preinstall, install or postinstall script (fails if a dependency gains one that sync leaves undecided)", () => {
  for (const [name, { build }] of Object.entries(DECLARED_PACKAGES))
    if (build === "none") assert.deepEqual(installScripts(name), [], name);
});
