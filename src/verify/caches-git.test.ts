import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { put } from "../guardrails/helpers/test-repo.ts";
import { ProjectCaches } from "./caches.ts";

function project(t: TestContext) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-caches-git-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const store = join(tmp, "store");
  const cache = join(tmp, "project/.antelope/cache");
  mkdirSync(cache, { recursive: true });
  const caches = new ProjectCaches(store);
  caches.seed(join(tmp, "project"));
  let steps = 0;
  const command = (files: Record<string, string>, ajs = true) => {
    steps += 1;
    const folder = join(tmp, "steps", String(steps));
    mkdirSync(folder, { recursive: true });
    for (const [path, text] of Object.entries(files)) put(cache, path, text);
    caches.observed({ folder }, ajs);
  };
  const later = (...paths: string[]) => {
    const next = join(tmp, "later");
    mkdirSync(next, { recursive: true });
    new ProjectCaches(store).seed(next);
    return paths.map((path) => existsSync(join(next, ".antelope/cache", path)));
  };
  return { cache, caches, command, later };
}

test("a git module ajs then overwrites in place with a registry version keeps the cache out, where following only registry versions hands a later project the git clone and its build inside the registry module", (t) => {
  const { caches, command, later } = project(t);
  command({
    "x/.git/HEAD": "ref: refs/heads/main\n",
    "x/dist/built.txt": "A\n",
    "manifest.json": '{"x":"git:main:abc"}',
  });
  command({ "x/value.txt": "installed\n", "manifest.json": '{"x":"1.0.0"}' });
  assert.match(
    caches.keep().join("\n"),
    /x changed from a git module to 1\.0\.0 after ajs installed it/,
  );
  assert.deepEqual(later("x/value.txt", "x/dist/built.txt"), [false, false]);
});

test("a folder the harness cannot read inside a git module leaves the registry modules kept, where a check that walks the left-out git folder refuses the whole cache", (t) => {
  const { cache, caches, command, later } = project(t);
  command({
    "@acme/api/value.txt": "installed\n",
    "gitmod/dist/private/secret.txt": "built\n",
    "manifest.json": '{"@acme/api":"1.0.0","gitmod":"git:main:abc"}',
  });
  const locked = join(cache, "gitmod/dist/private");
  chmodSync(locked, 0);
  const skipped = caches.keep();
  chmodSync(locked, 0o755);
  assert.deepEqual(skipped, []);
  assert.deepEqual(later("@acme/api/value.txt", "gitmod"), [true, false]);
});

test("a git module and a registry module that appear in one command that is not ajs keep the cache out, where a check that counts only registry modules keeps a module the git install command may have changed", (t) => {
  const { caches, command, later } = project(t);
  command(
    {
      "@acme/api/value.txt": "installed\n",
      "gitmod/dist/built.txt": "A\n",
      "manifest.json": '{"@acme/api":"1.0.0","gitmod":"git:main:abc"}',
    },
    false,
  );
  assert.match(
    caches.keep().join("\n"),
    /@acme\/api@1\.0\.0 and gitmod@git:main:abc appeared in one command that is not ajs/,
  );
  assert.deepEqual(later("@acme/api/value.txt"), [false]);
});
