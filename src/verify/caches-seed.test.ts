import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { put } from "../guardrails/helpers/test-repo.ts";
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
