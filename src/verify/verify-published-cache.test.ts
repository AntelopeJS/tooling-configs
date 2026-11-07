import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  feature,
  PUBLISH_DOORS,
  verify,
  verifyRepo,
} from "./helpers/verify-repo.ts";
import { entries, text, truncate } from "./helpers/folder-reads.ts";
import { FIRST, PACKAGE, startRegistry } from "./helpers/fake-registry.ts";

const SKILL = ".agents/skills/verify-interface";

interface Setup {
  root: string;
  tmp: string;
  registry: string;
  env: Record<string, string>;
  cached: string;
}

async function setup(t: TestContext): Promise<Setup> {
  const tmp = mkdtempSync(join(tmpdir(), "verify-published-cache-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const registry = await startRegistry(t);
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "package.json": `${JSON.stringify({ name: PACKAGE, version: FIRST })}\n`,
    [`${SKILL}/verify.config.ts`]: `export default {
  doors: ${PUBLISH_DOORS},
  setup: [],
  env: { npm_config_registry: ${JSON.stringify(registry)}, npm_config_fetch_retries: "0" },
  journeys: {},
};
`,
    [`${SKILL}/features/smoke.md`]: feature([], ["minor-bump"]),
  });
  const env = { XDG_CACHE_HOME: join(tmp, "cache") };
  const cached = join(
    env.XDG_CACHE_HOME,
    "antelopejs-verify/published",
    PACKAGE.replace("/", "+"),
    FIRST,
  );
  return { root, tmp, registry, env, cached };
}

function journey(setupResult: Setup) {
  const { root, tmp, env } = setupResult;
  const run = verify(root, tmp, ["new", "--kind", "interface"], env);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const folder = run.stdout.trim().split("\n").at(-1) ?? "";
  const result = verify(
    root,
    tmp,
    ["journey", folder, "smoke", "--kind", "interface"],
    env,
  );
  return { folder, result };
}

async function tarballRequests(registry: string): Promise<number> {
  const log: string[] = await (await fetch(`${registry}/requests`)).json();
  return log.filter((line) => line.includes("/tarballs/")).length;
}

function stepNames(folder: string): string[] {
  return entries(join(folder, "evidence/smoke/minor-bump"));
}

function cachedTarballs(folder: string): string[] {
  return entries(folder).filter((file) => file.endsWith(".tgz"));
}

test("a second run with the tarball cached downloads nothing, where an implementation that packs on every run downloads it again", async (t) => {
  const state = await setup(t);
  const first = journey(state);
  assert.match(first.result.stdout, /^PASS smoke\/minor-bump$/m);
  assert.equal(await tarballRequests(state.registry), 1);
  assert.equal(cachedTarballs(state.cached).length, 1);
  assert.equal(
    stepNames(first.folder).some((name) => /reuse-cached/.test(name)),
    false,
  );
  const second = journey(state);
  assert.match(second.result.stdout, /^PASS smoke\/minor-bump$/m);
  assert.equal(await tarballRequests(state.registry), 1);
  const steps = stepNames(second.folder);
  assert.equal(
    steps.some((name) => /npm-pack/.test(name)),
    false,
  );
  const reuse = steps.find((name) => /reuse-cached/.test(name)) ?? "";
  assert.match(
    text(
      join(second.folder, "evidence/smoke/minor-bump", reuse, "checks.json"),
    ),
    /no npm pack ran[\s\S]*antelopejs-verify\/published\/@acme\+stale-packument\/1\.7\.0\/\S+\.tgz/,
  );
});

test("a corrupt cached tarball is deleted and packed again, where an implementation that trusts any cached file fails the journey for good", async (t) => {
  const state = await setup(t);
  journey(state);
  const [name] = cachedTarballs(state.cached);
  writeFileSync(join(state.cached, name), "not a gzip archive");
  const repaired = journey(state);
  assert.match(repaired.result.stdout, /^PASS smoke\/minor-bump$/m);
  assert.equal(await tarballRequests(state.registry), 2);
  assert.notEqual(text(join(state.cached, name)), "not a gzip archive");
  const after = journey(state);
  assert.match(after.result.stdout, /^PASS smoke\/minor-bump$/m);
  assert.equal(await tarballRequests(state.registry), 2);
});

test("a truncated cached tarball is repacked, where an implementation that only checks the file exists keeps failing", async (t) => {
  const state = await setup(t);
  journey(state);
  const [name] = cachedTarballs(state.cached);
  truncate(join(state.cached, name), 20);
  const repaired = journey(state);
  assert.match(repaired.result.stdout, /^PASS smoke\/minor-bump$/m);
  assert.equal(await tarballRequests(state.registry), 2);
});

test("a temp pack folder left by an interrupted run is never read as the cache, where an implementation that scans the cache tree reuses its partial tarball", async (t) => {
  const state = await setup(t);
  const leftovers = [
    join(`${state.cached}.pack-interrupted`),
    join(state.cached, ".pack-interrupted"),
  ];
  for (const folder of leftovers) {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "acme-stale-packument-1.7.0.tgz"), "partial");
  }
  const run = journey(state);
  assert.match(run.result.stdout, /^PASS smoke\/minor-bump$/m);
  assert.equal(await tarballRequests(state.registry), 1);
  assert.equal(cachedTarballs(state.cached).length, 1);
  assert.equal(
    stepNames(run.folder).some((name) => /cached/.test(name)),
    false,
  );
});

test("a successful pack leaves no staging folder next to the cache, where an implementation that packs in place and never cleans up accumulates them", async (t) => {
  const state = await setup(t);
  journey(state);
  const siblings = entries(join(state.cached, ".."));
  assert.deepEqual(siblings, [FIRST]);
});

test("a pack that fails leaves the cache empty and the journey failed, where an implementation that caches the partial output or swallows the failure passes", async (t) => {
  const state = await setup(t);
  await fetch(`${state.registry}/break-tarballs`, { method: "POST" });
  const run = journey(state);
  assert.doesNotMatch(run.result.stdout, /^PASS smoke\/minor-bump$/m);
  assert.equal(cachedTarballs(state.cached).length, 0);
  assert.deepEqual(entries(join(state.cached, "..")), []);
});
