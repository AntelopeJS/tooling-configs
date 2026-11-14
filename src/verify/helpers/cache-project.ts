import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { put } from "../../guardrails/helpers/test-repo.ts";
import { ProjectCaches } from "../caches.ts";

/**
 * A project with an empty `.antelope/cache` that a fresh `ProjectCaches` follows. `command` writes `files` into the cache as one command does and observes it, `ajs` telling whether only `ajs` ran. `later` seeds another project from the store and tells which of `paths` its cache holds.
 */
export function cacheProject(t: TestContext) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-caches-project-"));
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
