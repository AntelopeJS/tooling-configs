import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { PACKAGE_ROOT, read } from "../guardrails/helpers/test-repo.ts";
import {
  evidence,
  feature,
  PUBLISH_DOORS,
  verify,
  verifyRepo,
} from "./helpers/verify-repo.ts";
import { entries } from "./helpers/folder-reads.ts";
import {
  archive,
  FIRST,
  PACKAGE,
  startRegistry,
} from "./helpers/fake-registry.ts";

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
  assert.match(first.result.stdout, /^PASS smoke\/minor-bump \(\d+\.\d s\)$/m);
  assert.equal(await tarballRequests(state.registry), 1);
  assert.equal(cachedTarballs(state.cached).length, 1);
  assert.equal(
    stepNames(first.folder).some((name) => /reuse-cached/.test(name)),
    false,
  );
  const second = journey(state);
  assert.match(second.result.stdout, /^PASS smoke\/minor-bump \(\d+\.\d s\)$/m);
  assert.equal(await tarballRequests(state.registry), 1);
  const steps = stepNames(second.folder);
  assert.equal(
    steps.some((name) => /npm-pack/.test(name)),
    false,
  );
  const reuse = steps.find((name) => /reuse-cached/.test(name)) ?? "";
  const [check] = evidence(
    second.folder,
    `smoke/minor-bump/${reuse}/checks.json`,
  );
  assert.match(check.name, /no npm pack ran/);
  assert.match(
    check.detail,
    /antelopejs-verify\/published\/@acme\+stale-packument\/1\.7\.0\/\S+\.tgz/,
  );
});

test("a corrupt cached tarball is deleted and packed again, where an implementation that trusts any cached file fails the journey for good", async (t) => {
  const state = await setup(t);
  journey(state);
  const [name] = cachedTarballs(state.cached);
  writeFileSync(join(state.cached, name), "not a gzip archive");
  const repaired = journey(state);
  assert.match(
    repaired.result.stdout,
    /^PASS smoke\/minor-bump \(\d+\.\d s\)$/m,
  );
  assert.equal(await tarballRequests(state.registry), 2);
  assert.notEqual(read(state.cached, name), "not a gzip archive");
  const after = journey(state);
  assert.match(after.result.stdout, /^PASS smoke\/minor-bump \(\d+\.\d s\)$/m);
  assert.equal(await tarballRequests(state.registry), 2);
});

test("a truncated cached tarball that keeps its gzip magic bytes is repacked, where a check that only looks at the gzip magic bytes reuses it", async (t) => {
  const state = await setup(t);
  journey(state);
  const [name] = cachedTarballs(state.cached);
  truncateSync(join(state.cached, name), 20);
  const repaired = journey(state);
  assert.match(
    repaired.result.stdout,
    /^PASS smoke\/minor-bump \(\d+\.\d s\)$/m,
  );
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
  assert.match(run.result.stdout, /^PASS smoke\/minor-bump \(\d+\.\d s\)$/m);
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
  assert.doesNotMatch(
    run.result.stdout,
    /^PASS smoke\/minor-bump \(\d+\.\d s\)$/m,
  );
  assert.equal(cachedTarballs(state.cached).length, 0);
  assert.deepEqual(entries(join(state.cached, "..")), []);
});

test("a cached tarball swapped for a valid tarball of another package is repacked, where an implementation that trusts any tarball tar can extract reuses the wrong package", async (t) => {
  const state = await setup(t);
  journey(state);
  const [name] = cachedTarballs(state.cached);
  const genuine = read(state.cached, name);
  writeFileSync(
    join(state.cached, name),
    archive({
      "package.json": JSON.stringify({
        name: "@other/package",
        version: FIRST,
      }),
    }),
  );
  const repaired = journey(state);
  assert.match(
    repaired.result.stdout,
    /^PASS smoke\/minor-bump \(\d+\.\d s\)$/m,
  );
  assert.equal(await tarballRequests(state.registry), 2);
  assert.deepEqual(cachedTarballs(state.cached), [name]);
  assert.equal(read(state.cached, name), genuine);
  assert.equal(
    stepNames(repaired.folder).some((step) => /discard-cached/.test(step)),
    true,
  );
});

test("two tarballs in the version folder are never trusted, where an implementation that reuses a tarball whose integrity matches ignores the second one", async (t) => {
  const state = await setup(t);
  journey(state);
  const [name] = cachedTarballs(state.cached);
  copyFileSync(join(state.cached, name), join(state.cached, "copy.tgz"));
  const repaired = journey(state);
  assert.match(
    repaired.result.stdout,
    /^PASS smoke\/minor-bump \(\d+\.\d s\)$/m,
  );
  assert.equal(await tarballRequests(state.registry), 2);
  assert.equal(cachedTarballs(state.cached).length, 1);
});

test("a packed tarball whose integrity is not the published one fails the journey naming both and is not cached, where an implementation that skips the check passes", async (t) => {
  const state = await setup(t);
  await fetch(`${state.registry}/lie-about-integrity`, { method: "POST" });
  const run = journey(state);
  assert.doesNotMatch(
    run.result.stdout,
    /^PASS smoke\/minor-bump \(\d+\.\d s\)$/m,
  );
  assert.deepEqual(entries(join(state.cached, "..")), []);
  const step = stepNames(run.folder).find((name) => /check-packed/.test(name));
  const [check] = evidence(run.folder, `smoke/minor-bump/${step}/checks.json`);
  assert.equal(check.pass, false);
  assert.match(check.detail, /packed sha512-.+, published sha512-A{86}==/);
});

test("an interrupt during the pack deletes the staging folder, where an implementation that cleans up only in finally leaves it behind", async (t) => {
  const state = await setup(t);
  await fetch(`${state.registry}/hang-tarballs`, { method: "POST" });
  const created = verify(
    state.root,
    state.tmp,
    ["new", "--kind", "interface"],
    state.env,
  );
  const folder = created.stdout.trim().split("\n").at(-1) ?? "";
  const child = spawn(
    process.execPath,
    [
      join(PACKAGE_ROOT, "src/bin/verify.ts"),
      "journey",
      folder,
      "smoke",
      "--kind",
      "interface",
    ],
    {
      cwd: state.root,
      env: { ...process.env, CI: "1", TMPDIR: state.tmp, ...state.env },
    },
  );
  const exited = new Promise<number | null>((resolve) =>
    child.on("exit", (code) => resolve(code)),
  );
  const parent = join(state.cached, "..");
  const staging = () =>
    entries(parent).filter((name) => name.startsWith(`${FIRST}.pack-`));
  const deadline = Date.now() + 60_000;
  while (staging().length === 0) {
    assert.ok(Date.now() < deadline, "the pack began within 60 s");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill("SIGTERM");
  assert.equal(await exited, 143);
  assert.deepEqual(entries(parent), []);
});

test("an integrity that lists sha1 before sha512 reuses the cache on the second run, where a comparison of the whole value fails every run", async (t) => {
  const state = await setup(t);
  await fetch(`${state.registry}/integrity-sha1-sha512`, { method: "POST" });
  assert.match(
    journey(state).result.stdout,
    /^PASS smoke\/minor-bump \(\d+\.\d s\)$/m,
  );
  assert.match(
    journey(state).result.stdout,
    /^PASS smoke\/minor-bump \(\d+\.\d s\)$/m,
  );
  assert.equal(await tarballRequests(state.registry), 1);
});

test("a sha1-only integrity passes and writes nothing to the cache, where an implementation that caches what it cannot check discards it on every run", async (t) => {
  const state = await setup(t);
  await fetch(`${state.registry}/integrity-sha1`, { method: "POST" });
  assert.match(
    journey(state).result.stdout,
    /^PASS smoke\/minor-bump \(\d+\.\d s\)$/m,
  );
  assert.deepEqual(entries(join(state.cached, "..")), []);
});
