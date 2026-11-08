import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import test from "node:test";

import { parseManifest } from "./package.ts";
import { bin, PACKAGE_ROOT, put, read, testRepo } from "./helpers/test-repo.ts";

const CAPTURE_PEERS = [
  "mongodb-memory-server",
  "pixelmatch",
  "playwright-core",
  "sharp",
];

function packRanges(): Record<string, string | undefined> {
  const tested = parseManifest(
    read(PACKAGE_ROOT, "package.json"),
  ).devDependencies;
  return Object.fromEntries(
    CAPTURE_PEERS.map((name) => [name, tested?.[name]]),
  );
}

function capturePeers(root: string): Record<string, string | undefined> {
  const declared =
    parseManifest(read(root, "package.json")).devDependencies ?? {};
  return Object.fromEntries(
    CAPTURE_PEERS.map((name) => [name, declared[name]]),
  );
}

function syncedRepo(t: TestContext): string {
  const root = testRepo(t);
  put(
    root,
    "guardrails.ratchet.json",
    '{"rules":{"eslint/no-alert":1},"oversizeFiles":{}}\n',
  );
  const synced = bin(root, "sync");
  assert.equal(synced.status, 0, synced.stderr);
  return root;
}

function declare(root: string, peers: Record<string, string>): void {
  const manifest = parseManifest(read(root, "package.json"));
  manifest.devDependencies = Object.fromEntries(
    Object.entries({ ...manifest.devDependencies, ...peers }).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  );
  put(root, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);
}

test("adding docs/captures.ts makes check fail until sync adds the capture peers at the pack's tested ranges", (t) => {
  const root = syncedRepo(t);
  put(root, "docs/captures.ts", "export default [];\n");
  const before = bin(root, "sync", ["--check"]);
  assert.equal(before.status, 1, before.stdout);
  assert.equal(before.stdout, "Drift: package.json; run antelopejs-sync\n");
  const synced = bin(root, "sync");
  assert.equal(synced.status, 0, synced.stderr);
  assert.match(synced.stdout, /Added devDependencies/);
  assert.deepEqual(capturePeers(root), packRanges());
  const after = bin(root, "sync", ["--check"]);
  assert.equal(after.status, 0, after.stdout + after.stderr);
});

test("a declared capture peer inside the tested range or from a pnpm catalog is kept, and one below or above it fails check and is replaced", (t) => {
  const root = syncedRepo(t);
  put(root, "docs/captures.ts", "export default [];\n");
  const tested = packRanges();
  const floor = /(\d+)\.(\d+)\.(\d+)/.exec(tested.sharp ?? "");
  assert.ok(floor);
  const inside = `^${floor[1]}.${floor[2]}.${Number(floor[3]) + 1}`;
  declare(root, {
    sharp: inside,
    "playwright-core": "^1.0.0",
    pixelmatch: "^999.0.0",
    "mongodb-memory-server": "catalog:",
  });
  const outside = bin(root, "sync", ["--check"]);
  assert.equal(outside.status, 1, outside.stdout);
  bin(root, "sync");
  assert.deepEqual(capturePeers(root), {
    ...tested,
    sharp: inside,
    "mongodb-memory-server": "catalog:",
  });
  const after = bin(root, "sync", ["--check"]);
  assert.equal(after.status, 0, after.stdout + after.stderr);
});

test("a repository without docs/captures.ts gets no capture peer", (t) => {
  const root = syncedRepo(t);
  assert.deepEqual(Object.values(capturePeers(root)).filter(Boolean), []);
});
