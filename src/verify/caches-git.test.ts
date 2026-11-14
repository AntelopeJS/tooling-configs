import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { cacheProject as project } from "./helpers/cache-project.ts";

test("a git module a command that is not ajs relists under its key as a registry version keeps the cache out, where following only registry versions hands a later project the git clone and its build inside the registry module", (t) => {
  const { caches, command, later } = project(t);
  command({
    "x/.git/HEAD": "ref: refs/heads/main\n",
    "x/dist/built.txt": "A\n",
    "manifest.json": '{"x":"git:main:abc"}',
  });
  command(
    { "x/value.txt": "installed\n", "manifest.json": '{"x":"1.0.0"}' },
    false,
  );
  assert.match(
    caches.keep().join("\n"),
    /x changed from a git module to 1\.0\.0 after ajs installed it/,
  );
  assert.deepEqual(later("x/value.txt", "x/dist/built.txt"), [false, false]);
});

test("a registry module a command that is not ajs relists under its key as a git module keeps the cache out, where a check that skips every git version follows the rewritten module no more and keeps it with the files the command wrote", (t) => {
  const { caches, command, later } = project(t);
  command({
    "@acme/api@1.0.0/value.txt": "installed\n",
    "@acme/other@1.0.0/value.txt": "installed\n",
    "manifest.json": '{"@acme/api@1.0.0":"1.0.0","@acme/other@1.0.0":"1.0.0"}',
  });
  command(
    {
      "@acme/api@1.0.0/dist/built.txt": "A\n",
      "manifest.json":
        '{"@acme/api@1.0.0":"git:main:abc","@acme/other@1.0.0":"1.0.0"}',
    },
    false,
  );
  assert.match(
    caches.keep().join("\n"),
    /@acme\/api@1\.0\.0 changed from 1\.0\.0 to git:main:abc after ajs installed it/,
  );
  assert.deepEqual(later("@acme/other@1.0.0/value.txt"), [false]);
});

test("a folder the harness cannot read inside a git module leaves the registry modules kept, where a check that walks the left-out git folder refuses the whole cache", (t) => {
  const { cache, caches, command, later } = project(t);
  command({
    "@acme/api@1.0.0/value.txt": "installed\n",
    "gitmod/dist/private/secret.txt": "built\n",
    "manifest.json": '{"@acme/api@1.0.0":"1.0.0","gitmod":"git:main:abc"}',
  });
  const locked = join(cache, "gitmod/dist/private");
  chmodSync(locked, 0);
  const skipped = caches.keep();
  chmodSync(locked, 0o755);
  assert.deepEqual(skipped, []);
  assert.deepEqual(later("@acme/api@1.0.0/value.txt", "gitmod"), [true, false]);
});

test("a git module and a registry module that appear in one command that is not ajs keep the cache out, where a check that counts only registry modules keeps a module the git install command may have changed", (t) => {
  const { caches, command, later } = project(t);
  command(
    {
      "@acme/api@1.0.0/value.txt": "installed\n",
      "gitmod/dist/built.txt": "A\n",
      "manifest.json": '{"@acme/api@1.0.0":"1.0.0","gitmod":"git:main:abc"}',
    },
    false,
  );
  assert.match(
    caches.keep().join("\n"),
    /@acme\/api@1\.0\.0 and gitmod@git:main:abc appeared in one command that is not ajs/,
  );
  assert.deepEqual(later("@acme/api@1.0.0/value.txt"), [false]);
});
