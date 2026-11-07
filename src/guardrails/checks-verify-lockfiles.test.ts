import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  type FixtureManifest,
  NO_DEPENDENCIES,
  npmLock,
  pnpmLock,
} from "./helpers/lockfiles.ts";
import { put } from "./helpers/test-repo.ts";
import { checkLockfiles } from "./verify-lockfiles.ts";

const LAYER = ".agents/skills/verify-dms-app";
const PLAYGROUND = `${LAYER}/playground`;
const LEFT_PAD = { "left-pad": "^1.3.0" };

function repo(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "antelope-lockfiles-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, `${LAYER}/verify.config.ts`, "export default {};\n");
  put(root, `${LAYER}/package.json`, JSON.stringify(NO_DEPENDENCIES));
  return root;
}

function manifest(fields: FixtureManifest): string {
  return JSON.stringify({ ...NO_DEPENDENCIES, ...fields });
}

function stalePnpm(t: TestContext, mine: string, theirs: string): string {
  const root = repo(t);
  put(root, `${PLAYGROUND}/package.json`, mine);
  put(root, `${PLAYGROUND}/pnpm-lock.yaml`, theirs);
  return checkLockfiles(root);
}

const PNPM_HEAD = `${PLAYGROUND}/pnpm-lock.yaml does not match ${PLAYGROUND}/package.json: run \`pnpm install --dir ${PLAYGROUND} --ignore-workspace --lockfile-only\`.\n`;

for (const { title, mine, theirs, line } of [
  {
    title:
      "a dependency package.json adds fails, caught by comparing only what the lockfile lists",
    mine: manifest({ dependencies: LEFT_PAD }),
    theirs: pnpmLock({ ".": {} }),
    line: `importer "." dependencies "left-pad": the manifests ask for "^1.3.0", the lockfile has none.`,
  },
  {
    title:
      "a dependency package.json removes fails, caught by comparing only what package.json lists",
    mine: manifest({}),
    theirs: pnpmLock({ ".": { devDependencies: LEFT_PAD } }),
    line: `importer "." devDependencies "left-pad": the manifests ask for none, the lockfile has "^1.3.0".`,
  },
  {
    title:
      "a changed specifier fails, caught by comparing dependency names only",
    mine: manifest({ optionalDependencies: { "left-pad": "^2.0.0" } }),
    theirs: pnpmLock({ ".": { optionalDependencies: LEFT_PAD } }),
    line: `importer "." optionalDependencies "left-pad": the manifests ask for "^2.0.0", the lockfile has "^1.3.0".`,
  },
  {
    title:
      "a dependency moved to devDependencies fails, caught by comparing names across fields",
    mine: manifest({ devDependencies: LEFT_PAD }),
    theirs: pnpmLock({ ".": { dependencies: LEFT_PAD } }),
    line: `importer "." dependencies "left-pad": the manifests ask for none, the lockfile has "^1.3.0".\n  importer "." devDependencies "left-pad": the manifests ask for "^1.3.0", the lockfile has none.`,
  },
  {
    title:
      "a changed pnpm.overrides entry fails, caught by an implementation that ignores overrides",
    mine: manifest({ pnpm: { overrides: { "left-pad": "1.3.0" } } }),
    theirs: pnpmLock({ ".": {} }, { overrides: { "left-pad": "1.2.0" } }),
    line: `overrides "left-pad": the manifests ask for "1.3.0", the lockfile has "1.2.0".`,
  },
  {
    title:
      "an override the lockfile keeps after package.json dropped it fails, caught by comparing overrides one way",
    mine: manifest({}),
    theirs: pnpmLock({ ".": {} }, { overrides: { "left-pad": "1.2.0" } }),
    line: `overrides "left-pad": the manifests ask for none, the lockfile has "1.2.0".`,
  },
  {
    title:
      "a lockfile made with autoInstallPeers off fails under the default, caught by an implementation that ignores settings",
    mine: manifest({}),
    theirs: pnpmLock({ ".": {} }, { settings: { autoInstallPeers: false } }),
    line: `settings "autoInstallPeers": the manifests ask for "true", the lockfile has "false".`,
  },
])
  test(`pnpm: ${title}`, (t) => {
    assert.equal(stalePnpm(t, mine, theirs), `${PNPM_HEAD}  ${line}\n`);
  });

for (const { title, mine, theirs } of [
  {
    title:
      "a peer dependency pnpm installs as a dependency matches, caught by an implementation that ignores autoInstallPeers",
    mine: manifest({ peerDependencies: LEFT_PAD }),
    theirs: pnpmLock({ ".": { dependencies: LEFT_PAD } }),
  },
  {
    title:
      "a `$name` override matches the specifier it names, caught by comparing the reference literally",
    mine: manifest({
      dependencies: LEFT_PAD,
      pnpm: { overrides: { "left-pad": "$left-pad" } },
    }),
    theirs: pnpmLock(
      { ".": { dependencies: LEFT_PAD } },
      { overrides: { "left-pad": "^1.3.0" } },
    ),
  },
  {
    title:
      "pnpm.overrides is ignored when packageManager pins pnpm 11 or later, caught by reading it for every version",
    mine: manifest({
      packageManager: "pnpm@11.0.0",
      pnpm: { overrides: { "left-pad": "1.2.0" } },
    }),
    theirs: pnpmLock({ ".": {} }),
  },
])
  test(`pnpm: ${title}`, (t) => {
    assert.equal(stalePnpm(t, mine, theirs), "");
  });

test("pnpm: a stale sub-importer of a workspace playground fails, caught by an implementation that compares only the root importer", (t) => {
  const root = repo(t);
  put(root, `${PLAYGROUND}/pnpm-workspace.yaml`, "packages:\n  - packages/*\n");
  put(root, `${PLAYGROUND}/package.json`, manifest({ dependencies: LEFT_PAD }));
  put(
    root,
    `${PLAYGROUND}/packages/app/package.json`,
    manifest({ dependencies: { "left-pad": "^2.0.0" } }),
  );
  put(
    root,
    `${PLAYGROUND}/packages/tool/package.json`,
    manifest({ devDependencies: LEFT_PAD }),
  );
  put(
    root,
    `${PLAYGROUND}/pnpm-lock.yaml`,
    pnpmLock({
      ".": { dependencies: LEFT_PAD },
      "packages/app": { dependencies: LEFT_PAD },
    }),
  );
  assert.equal(
    checkLockfiles(root),
    `${PLAYGROUND}/pnpm-lock.yaml does not match ${PLAYGROUND}/package.json: run \`pnpm install --dir ${PLAYGROUND} --lockfile-only\`.\n` +
      `  importer "packages/app" dependencies "left-pad": the manifests ask for "^2.0.0", the lockfile has "^1.3.0".\n` +
      `  importer "packages/tool": a workspace package the lockfile does not list.\n` +
      `  importer "packages/tool" devDependencies "left-pad": the manifests ask for "^1.3.0", the lockfile has none.\n`,
  );
});

test("pnpm: a stale layer lockfile still fails under a root pnpm-workspace.yaml, caught by an implementation that defers to the root workspace", (t) => {
  const root = repo(t);
  put(root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n  - '.'\n");
  put(root, `${PLAYGROUND}/package.json`, manifest({ dependencies: LEFT_PAD }));
  put(root, `${PLAYGROUND}/pnpm-lock.yaml`, pnpmLock({ ".": {} }));
  assert.match(checkLockfiles(root), /does not match/);
});

test("a package.json with dependencies and no lockfile fails, caught by an implementation that checks only the lockfiles it finds", (t) => {
  const root = repo(t);
  put(root, `${PLAYGROUND}/package.json`, manifest({ dependencies: LEFT_PAD }));
  assert.equal(
    checkLockfiles(root),
    `${PLAYGROUND}/package.json has dependencies and no lockfile: run \`pnpm install --dir ${PLAYGROUND} --ignore-workspace --lockfile-only\`.\n`,
  );
});

test("a root playground the root pnpm workspace lists needs no lockfile of its own, caught by requiring one in every folder", (t) => {
  const root = repo(t);
  put(root, "pnpm-workspace.yaml", "packages:\n  - './'\n  - playground\n");
  put(root, "playground/package.json", manifest({ dependencies: LEFT_PAD }));
  put(
    root,
    `${LAYER}/node_modules/dep/package.json`,
    manifest({ dependencies: LEFT_PAD }),
  );
  assert.equal(checkLockfiles(root), "");
});

for (const [file, content] of [
  ["pnpm-lock.yaml", "importers: [\n"],
  ["pnpm-lock.yaml", "lockfileVersion: 5.4\nspecifiers:\n  left-pad: ^1.3.0\n"],
  ["package-lock.json", JSON.stringify({ lockfileVersion: 1 })],
])
  test(`${file} that cannot be read as a known version fails, caught by an implementation that passes what it cannot parse: ${content.slice(0, 20)}`, (t) => {
    const root = repo(t);
    put(
      root,
      `${PLAYGROUND}/package.json`,
      manifest({ dependencies: LEFT_PAD }),
    );
    put(root, `${PLAYGROUND}/${file}`, content);
    assert.equal(
      checkLockfiles(root),
      `${PLAYGROUND}/${file}: could not read it, a package.json or a pnpm-workspace.yaml it depends on, as a version this check knows.\n`,
    );
  });

const NPM_HEAD = `${PLAYGROUND}/package-lock.json does not match ${PLAYGROUND}/package.json: run \`npm install --package-lock-only --prefix ${PLAYGROUND}\`.\n`;

for (const { title, mine, theirs, line } of [
  {
    title: "a dependency package.json adds fails",
    mine: { dependencies: LEFT_PAD },
    theirs: {},
    line: `dependencies "left-pad": the manifests ask for "^1.3.0", the lockfile has none.`,
  },
  {
    title: "a dependency package.json removes fails",
    mine: {},
    theirs: { peerDependencies: LEFT_PAD },
    line: `peerDependencies "left-pad": the manifests ask for none, the lockfile has "^1.3.0".`,
  },
  {
    title: "a changed specifier fails",
    mine: { devDependencies: { "left-pad": "^2.0.0" } },
    theirs: { devDependencies: LEFT_PAD },
    line: `devDependencies "left-pad": the manifests ask for "^2.0.0", the lockfile has "^1.3.0".`,
  },
])
  test(`npm: ${title}, caught by an implementation that passes it through a could-not-check branch or compares one way`, (t) => {
    const root = repo(t);
    put(root, `${PLAYGROUND}/package.json`, manifest(mine));
    put(root, `${PLAYGROUND}/package-lock.json`, npmLock(theirs));
    assert.equal(checkLockfiles(root), `${NPM_HEAD}  ${line}\n`);
  });

test("npm: a dependency also listed as optional matches a lockfile that records it once, as npm normalizes it, caught by comparing package.json raw", (t) => {
  const root = repo(t);
  put(
    root,
    `${PLAYGROUND}/package.json`,
    manifest({ dependencies: LEFT_PAD, optionalDependencies: LEFT_PAD }),
  );
  put(
    root,
    `${PLAYGROUND}/package-lock.json`,
    npmLock({ optionalDependencies: LEFT_PAD }),
  );
  assert.equal(checkLockfiles(root), "");
});
