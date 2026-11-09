import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { put, read } from "../guardrails/helpers/test-repo.ts";
import { ProjectCaches } from "./caches.ts";

function storeWithKeptCache(t: TestContext) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-caches-seed-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const store = join(tmp, "store");
  put(store, "kept/manifest.json", '{"@acme/api":"1.0.0"}\n');
  put(store, "kept/@acme/api/value.txt", "installed\n");
  return { tmp, store };
}

test("a project whose antelope config names its own cacheFolder gets no seeded .antelope/cache, where a seed that always copies hands it a cache ajs never reads", (t) => {
  const { tmp, store } = storeWithKeptCache(t);
  const project = join(tmp, "custom");
  put(project, "antelope.json", '{"cacheFolder":"ajs-modules"}\n');
  new ProjectCaches(store).seed(project);
  assert.equal(existsSync(join(project, ".antelope/cache")), false);
});

test("a project with the default cache folder gets the largest kept cache, where a seed that skips every project with an antelope config seeds nothing", (t) => {
  const { tmp, store } = storeWithKeptCache(t);
  const project = join(tmp, "default");
  put(project, "antelope.json", '{"modules":{}}\n');
  new ProjectCaches(store).seed(project);
  assert.equal(
    existsSync(join(project, ".antelope/cache/@acme/api/value.txt")),
    true,
  );
});

test("a seed ignores a staging copy another journey is still publishing to the store, even one listing more modules; a seed that reads every entry copies a half-written cache", (t) => {
  const { tmp, store } = storeWithKeptCache(t);
  put(
    store,
    ".staging-0a1b2c/manifest.json",
    '{"@acme/api":"1.0.0","@acme/extra":"1.0.0"}\n',
  );
  const project = join(tmp, "default");
  put(project, "package.json", "{}\n");
  new ProjectCaches(store).seed(project);
  assert.equal(
    existsSync(join(project, ".antelope/cache/@acme/api/value.txt")),
    true,
  );
});

test("a seeded project's .bin shims put its own module folders on NODE_PATH, where a seed that copies shims verbatim points them at the project the cache was kept from and one that reads the path as a replacement pattern mangles its $&", (t) => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "verify-caches-shim-")));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const caches = new ProjectCaches(join(tmp, "store"));
  const shim = (project: string) =>
    `export NODE_PATH="${join(project, ".antelope/cache/@acme/api/node_modules/.pnpm/node_modules")}"\n`;
  const first = join(tmp, "first");
  caches.seed(first);
  put(first, ".antelope/cache/@acme/api/node_modules/.bin/tool", shim(first));
  put(first, ".antelope/cache/manifest.json", '{"@acme/api":"1.0.0"}\n');
  assert.deepEqual(caches.keep(), []);
  const second = join(tmp, "second$&");
  put(second, "package.json", "{}\n");
  caches.seed(second);
  assert.equal(
    read(second, ".antelope/cache/@acme/api/node_modules/.bin/tool"),
    shim(second),
  );
});

test("a copy of a clean prepared cache has .bin shims naming its own module folders, where following the copy as is leaves them pointing at the build the copy was taken from", (t) => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "verify-caches-copy-")));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const shim = (project: string) =>
    `export NODE_PATH="${join(project, ".antelope/cache/@acme/api/node_modules/.pnpm/node_modules")}"\n`;
  const built = join(tmp, "built");
  const building = new ProjectCaches(join(tmp, "store"));
  building.seed(built);
  put(built, ".antelope/cache/@acme/api/node_modules/.bin/tool", shim(built));
  put(built, ".antelope/cache/manifest.json", '{"@acme/api":"1.0.0"}\n');
  const from = building.clean(built);
  assert.notEqual(from, null);
  const copy = join(tmp, "copy");
  cpSync(built, copy, { recursive: true, preserveTimestamps: true });
  new ProjectCaches(join(tmp, "store")).seed(copy, from);
  assert.equal(
    read(copy, ".antelope/cache/@acme/api/node_modules/.bin/tool"),
    shim(copy),
  );
});

test("a copy of a clean prepared cache reached through a symlink has .bin shims naming its own module folders, where retargeting only the resolved build path leaves the path the shim was written with", (t) => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "verify-caches-link-")));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const shim = (project: string) =>
    `export NODE_PATH="${join(project, ".antelope/cache/@acme/api/node_modules/.pnpm/node_modules")}"\n`;
  mkdirSync(join(tmp, "real"));
  symlinkSync(join(tmp, "real"), join(tmp, "link"));
  const built = join(tmp, "link/built");
  const building = new ProjectCaches(join(tmp, "store"));
  building.seed(built);
  put(built, ".antelope/cache/@acme/api/node_modules/.bin/tool", shim(built));
  put(built, ".antelope/cache/manifest.json", '{"@acme/api":"1.0.0"}\n');
  const copy = join(tmp, "copy");
  cpSync(built, copy, { recursive: true, preserveTimestamps: true });
  new ProjectCaches(join(tmp, "store")).seed(copy, building.clean(built));
  assert.equal(
    read(copy, ".antelope/cache/@acme/api/node_modules/.bin/tool"),
    shim(copy),
  );
});
