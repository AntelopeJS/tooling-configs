import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  type DependencyFields,
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

function manifest(fields: DependencyFields): string {
  return JSON.stringify({ ...NO_DEPENDENCIES, ...fields });
}

function playground(
  t: TestContext,
  mine: string,
  theirs: string,
  files: Record<string, string> = {},
): string {
  const root = repo(t);
  put(root, `${PLAYGROUND}/package.json`, mine);
  put(root, `${PLAYGROUND}/pnpm-lock.yaml`, theirs);
  for (const [path, content] of Object.entries(files))
    put(root, `${PLAYGROUND}/${path}`, content);
  return checkLockfiles(root);
}

const PNPM_HEAD = `${PLAYGROUND}/pnpm-lock.yaml does not match ${PLAYGROUND}/package.json: run \`pnpm install --dir ${PLAYGROUND} --ignore-workspace --lockfile-only\`.\n`;

for (const { title, mine, theirs, line } of [
  {
    title:
      "a dependency package.json adds fails, caught by comparing only what the lockfile lists",
    mine: manifest({ dependencies: LEFT_PAD }),
    theirs: pnpmLock({ ".": {} }),
    line: `importer "." "left-pad": package.json asks for "^1.3.0", the lockfile has none.`,
  },
  {
    title:
      "a dependency package.json removes fails, caught by comparing only what package.json lists",
    mine: manifest({}),
    theirs: pnpmLock({ ".": { devDependencies: LEFT_PAD } }),
    line: `importer "." "left-pad": package.json asks for none, the lockfile has "^1.3.0".`,
  },
  {
    title:
      "a changed specifier fails, caught by comparing dependency names only",
    mine: manifest({ optionalDependencies: { "left-pad": "^2.0.0" } }),
    theirs: pnpmLock({ ".": { optionalDependencies: LEFT_PAD } }),
    line: `importer "." "left-pad": package.json asks for "^2.0.0", the lockfile has "^1.3.0".`,
  },
  {
    title:
      "a catalog: specifier the lockfile records as a range fails, caught by resolving catalogs before comparing",
    mine: manifest({ dependencies: { "left-pad": "catalog:" } }),
    theirs: pnpmLock({ ".": { dependencies: LEFT_PAD } }),
    line: `importer "." "left-pad": package.json asks for "catalog:", the lockfile has "^1.3.0".`,
  },
])
  test(`pnpm: ${title}`, (t) => {
    assert.equal(playground(t, mine, theirs), `${PNPM_HEAD}  ${line}\n`);
  });

for (const { title, mine, theirs, files } of [
  {
    title:
      "a name in both dependencies and devDependencies matches a lockfile that records it once, caught by comparing field by field",
    mine: manifest({ dependencies: LEFT_PAD, devDependencies: LEFT_PAD }),
    theirs: pnpmLock({ ".": { dependencies: LEFT_PAD } }),
  },
  {
    title:
      "a peer the lockfile installs as a dependency matches, caught by an implementation that fails every lockfile name package.json does not list as a dependency",
    mine: manifest({ peerDependencies: LEFT_PAD }),
    theirs: pnpmLock({ ".": { dependencies: LEFT_PAD } }),
  },
  {
    title:
      "a peer the lockfile leaves out under auto-install-peers=false in .npmrc matches, caught by expecting every peer to be installed",
    mine: manifest({ peerDependencies: LEFT_PAD }),
    theirs: pnpmLock({ ".": {} }, { settings: { autoInstallPeers: false } }),
    files: { ".npmrc": "auto-install-peers=false\n" },
  },
  {
    title:
      "catalog: and workspace: specifiers match as pnpm records them, caught by resolving them before comparing",
    mine: manifest({
      dependencies: { "left-pad": "catalog:", tool: "workspace:^" },
    }),
    theirs: pnpmLock({
      ".": { dependencies: { "left-pad": "catalog:", tool: "workspace:^" } },
    }),
    files: {
      "pnpm-workspace.yaml":
        "packages:\n  - tool\ncatalog:\n  left-pad: ^1.3.0\n",
      "tool/package.json": JSON.stringify({ name: "tool", version: "1.0.0" }),
    },
  },
  {
    title:
      "overrides in a pnpm-workspace.yaml without packages match the specifier pnpm writes for them, caught by comparing an overridden name or the overrides themselves",
    mine: manifest({ dependencies: LEFT_PAD }),
    theirs: pnpmLock(
      { ".": { dependencies: { "left-pad": "1.3.0" } } },
      { overrides: { "left-pad": "1.3.0" } },
    ),
    files: { "pnpm-workspace.yaml": "overrides:\n  left-pad: 1.3.0\n" },
  },
  {
    title:
      "a catalog: override matches the version pnpm resolves it to, caught by comparing the overrides as written",
    mine: manifest({ dependencies: { "left-pad": "catalog:" } }),
    theirs: pnpmLock(
      { ".": { dependencies: LEFT_PAD } },
      { overrides: { "left-pad": "^1.3.0" } },
    ),
    files: {
      "pnpm-workspace.yaml":
        "catalog:\n  left-pad: ^1.3.0\noverrides:\n  left-pad: 'catalog:'\n",
    },
  },
  {
    title:
      "an override whose selector holds a range still exempts its package, caught by splitting the selector on every >",
    mine: manifest({ dependencies: LEFT_PAD }),
    theirs: pnpmLock(
      { ".": { dependencies: { "left-pad": "1.3.0" } } },
      { overrides: { "left-pad@>1.0.0": "1.3.0" } },
    ),
  },
  {
    title:
      "a workspace package the lockfile does not list passes, caught by computing membership from patterns where a leading negation must still exclude it",
    mine: manifest({ dependencies: LEFT_PAD }),
    theirs: pnpmLock({ ".": { dependencies: LEFT_PAD }, "packages/a": {} }),
    files: {
      "pnpm-workspace.yaml": "packages:\n  - '!packages/b'\n  - packages/*\n",
      "packages/a/package.json": manifest({}),
      "packages/b/package.json": manifest({ dependencies: LEFT_PAD }),
    },
  },
  {
    title:
      "an importer the lockfile lists without a package.json on disk is skipped, caught by reading a manifest for every importer",
    mine: manifest({ dependencies: LEFT_PAD }),
    theirs: pnpmLock({
      ".": { dependencies: LEFT_PAD },
      "packages/gone": { dependencies: LEFT_PAD },
    }),
  },
])
  test(`pnpm: ${title}`, (t) => {
    assert.equal(playground(t, mine, theirs, files), "");
  });

test("pnpm: a stale importer of a workspace playground fails, caught by an implementation that compares only the root importer", (t) => {
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
    `${PLAYGROUND}/pnpm-lock.yaml`,
    pnpmLock({
      ".": { dependencies: LEFT_PAD },
      "packages/app": { dependencies: LEFT_PAD },
    }),
  );
  assert.equal(
    checkLockfiles(root),
    `${PLAYGROUND}/pnpm-lock.yaml does not match ${PLAYGROUND}/package.json: run \`pnpm install --dir ${PLAYGROUND} --lockfile-only\`.\n` +
      `  importer "packages/app" "left-pad": package.json asks for "^2.0.0", the lockfile has "^1.3.0".\n`,
  );
});

test("pnpm: a stale layer lockfile still fails under a root pnpm-workspace.yaml, caught by an implementation that defers to the root workspace", (t) => {
  const root = repo(t);
  put(root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n  - '.'\n");
  put(root, `${PLAYGROUND}/package.json`, manifest({ dependencies: LEFT_PAD }));
  put(root, `${PLAYGROUND}/pnpm-lock.yaml`, pnpmLock({ ".": {} }));
  assert.match(checkLockfiles(root), /does not match/);
});

for (const [folder, above, command] of [
  [
    PLAYGROUND,
    undefined,
    `pnpm install --dir ${PLAYGROUND} --ignore-workspace --lockfile-only`,
  ],
  [
    "playground",
    "package-lock.json",
    "npm install --package-lock-only --prefix playground",
  ],
] as const)
  test(`a playground ${folder} with dependencies and no lockfile fails and names the ${command.split(" ")[0]} fix, caught by an implementation that checks only the lockfiles it finds or always suggests pnpm`, (t) => {
    const root = repo(t);
    if (above) put(root, above, npmLock({}));
    put(root, `${folder}/package.json`, manifest({ dependencies: LEFT_PAD }));
    assert.equal(
      checkLockfiles(root),
      `${folder}/package.json has dependencies and no lockfile: run \`${command}\`.\n`,
    );
  });

for (const { title, files } of [
  {
    title:
      "a nested fixture folder with dependencies and no lockfile passes, caught by requiring a lockfile in every folder under a layer",
    files: {
      [`${LAYER}/fixtures/consumer/package.json`]: manifest({
        dependencies: LEFT_PAD,
      }),
    },
  },
  {
    title:
      "a playground an npm workspace may list needs no lockfile of its own, caught by an implementation that ignores npm workspaces",
    files: {
      "package.json": JSON.stringify({
        ...NO_DEPENDENCIES,
        workspaces: ["playground"],
      }),
      "package-lock.json": npmLock({}),
      "playground/package.json": manifest({ dependencies: LEFT_PAD }),
    },
  },
  {
    title:
      "a playground under a root pnpm-workspace.yaml needs no lockfile of its own, caught by an implementation that evaluates workspace patterns",
    files: {
      "pnpm-workspace.yaml": "packages:\n  - './'\n  - playground\n",
      "playground/package.json": manifest({ dependencies: LEFT_PAD }),
    },
  },
])
  test(title, (t) => {
    const root = repo(t);
    for (const [path, content] of Object.entries(files))
      put(root, path, content);
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
      `${PLAYGROUND}/${file}: could not read it, or a package.json it locks, as a version this check knows.\n`,
    );
  });

const NPM_HEAD = `${PLAYGROUND}/package-lock.json does not match ${PLAYGROUND}/package.json: run \`npm install --package-lock-only --prefix ${PLAYGROUND}\`.\n`;

for (const { title, mine, theirs, line } of [
  {
    title: "a dependency package.json adds fails",
    mine: { dependencies: LEFT_PAD },
    theirs: {},
    line: `"left-pad": package.json asks for "^1.3.0", the lockfile has none.`,
  },
  {
    title: "a dependency package.json removes fails",
    mine: {},
    theirs: { devDependencies: LEFT_PAD },
    line: `"left-pad": package.json asks for none, the lockfile has "^1.3.0".`,
  },
  {
    title: "a changed specifier fails",
    mine: { devDependencies: { "left-pad": "^2.0.0" } },
    theirs: { devDependencies: LEFT_PAD },
    line: `"left-pad": package.json asks for "^2.0.0", the lockfile has "^1.3.0".`,
  },
])
  test(`npm: ${title}, caught by an implementation that passes it through a could-not-check branch or compares one way`, (t) => {
    const root = repo(t);
    put(root, `${PLAYGROUND}/package.json`, manifest(mine));
    put(root, `${PLAYGROUND}/package-lock.json`, npmLock(theirs));
    assert.equal(checkLockfiles(root), `${NPM_HEAD}  ${line}\n`);
  });

test("npm: a dependency also listed as optional matches a lockfile that records it once, as npm normalizes it, caught by comparing field by field", (t) => {
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
