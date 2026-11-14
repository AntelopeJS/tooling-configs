import assert from "node:assert/strict";
import test from "node:test";

import { cacheProject } from "./helpers/cache-project.ts";

test("a registry module whose version a command that is not ajs rewrites under its key keeps the cache out, where a check of files and folders alone keeps a manifest that lists a version no install gave", (t) => {
  const { caches, command, later } = cacheProject(t);
  command({
    "@acme/api@1.0.0/value.txt": "installed\n",
    "manifest.json": '{"@acme/api@1.0.0":"1.0.0"}',
  });
  command({ "manifest.json": '{"@acme/api@1.0.0":"2.0.0"}' }, false);
  assert.match(
    caches.keep().join("\n"),
    /@acme\/api@1\.0\.0 changed from 1\.0\.0 to 2\.0\.0 after ajs installed it/,
  );
  assert.deepEqual(later("@acme/api@1.0.0/value.txt"), [false]);
});

test("a registry module a command that is not ajs drops from the manifest keeps the cache out, where a check of the listed modules alone keeps its unlisted folder for a later project", (t) => {
  const { caches, command, later } = cacheProject(t);
  command({
    "@acme/api@1.0.0/value.txt": "installed\n",
    "manifest.json": '{"@acme/api@1.0.0":"1.0.0"}',
  });
  command({
    "@acme/extra@1.0.0/value.txt": "installed\n",
    "manifest.json": '{"@acme/api@1.0.0":"1.0.0","@acme/extra@1.0.0":"1.0.0"}',
  });
  command({ "manifest.json": '{"@acme/extra@1.0.0":"1.0.0"}' }, false);
  assert.match(
    caches.keep().join("\n"),
    /@acme\/api@1\.0\.0 left manifest\.json after ajs installed it/,
  );
  assert.deepEqual(later("@acme/extra@1.0.0/value.txt"), [false]);
});
