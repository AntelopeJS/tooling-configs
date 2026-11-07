import assert from "node:assert/strict";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { skillFolder } from "../verify/kinds.ts";
import { syncedFiles } from "../verify/skills.ts";
import { PACKAGE_ROOT, bin, put, read, testRepo } from "./helpers/test-repo.ts";

const BASE_STEPS = [
  "typecheck",
  "lint",
  "format:check",
  "knip",
  "test",
  "size",
  "suppressions",
  "sync:check",
];
const LAYER = skillFolder("interface");
const CLEAN_SOURCE = "export const answer: number = 42;\n";
const BROKEN_SOURCE = 'export const answer: number = "forty-two";\n';
const NO_DEPENDENCIES = JSON.stringify({
  name: "fixture",
  version: "1.0.0",
  private: true,
});
const WITH_DEPENDENCY = JSON.stringify({
  name: "fixture",
  version: "1.0.0",
  private: true,
  dependencies: { "left-pad": "^1.3.0" },
});
const PNPM_LOCK_WITHOUT_DEPENDENCIES =
  "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n";
const NPM_LOCK_WITH_DEPENDENCY = JSON.stringify({
  name: "fixture",
  version: "1.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": {
      name: "fixture",
      version: "1.0.0",
      dependencies: { "left-pad": "^1.3.0" },
    },
    "node_modules/left-pad": {
      version: "1.3.0",
      resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      integrity:
        "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==",
    },
  },
});

function checksRepo(t: TestContext): string {
  const root = testRepo(t);
  symlinkSync(
    join(PACKAGE_ROOT, "node_modules"),
    join(root, "node_modules"),
    "dir",
  );
  put(
    root,
    "package.json",
    JSON.stringify({
      name: "consumer",
      type: "module",
      packageManager: "npm@11.0.0",
      scripts: Object.fromEntries(
        BASE_STEPS.map((name) => [name, 'node -e "process.exit(0)"']),
      ),
    }),
  );
  put(
    root,
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        rootDir: "src",
        strict: true,
        noEmit: true,
        types: [],
      },
      include: ["src"],
    }),
  );
  put(root, "src/index.ts", "export const value = 1;\n");
  return root;
}

function withLayer(root: string, source: string): void {
  for (const { path, content } of syncedFiles("interface"))
    if (path.endsWith("tsconfig.json")) put(root, path, content);
  put(root, `${LAYER}/verify.config.ts`, source);
}

function layerRepo(t: TestContext, source: string): string {
  const root = checksRepo(t);
  withLayer(root, source);
  return root;
}

function run(root: string, env: Record<string, string> = {}) {
  return bin(root, "checks", ["--no-services"], env);
}

test("a verify layer with a type error fails the run under its own step and prints the compiler error", (t) => {
  const result = run(layerRepo(t, BROKEN_SOURCE));
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /\[verify:types\]\n[^\n]*verify\.config\.ts\(1,14\): error TS2322/,
  );
  assert.match(result.stdout, /Checks: 8 passed, 1 failed\.\n$/);
});

test("a clean verify layer passes silently and counts as one more passed step", (t) => {
  const result = run(layerRepo(t, CLEAN_SOURCE));
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "Checks: 9 passed, 0 failed.\n");
});

test("a repository without a verify layer runs and counts exactly the steps it did before", (t) => {
  const root = checksRepo(t);
  put(root, ".agents/skills/unslop/SKILL.md", "---\nname: unslop\n---\n");
  put(root, "playground/package.json", NO_DEPENDENCIES);
  put(root, "playground/pnpm-lock.yaml", "not a lockfile: [\n");
  const result = run(root);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "Checks: 8 passed, 0 failed.\n");
});

test("a type error in a layer file other than verify.config.ts fails too", (t) => {
  const root = layerRepo(t, CLEAN_SOURCE);
  put(root, `${LAYER}/journeys/broken.ts`, BROKEN_SOURCE);
  const result = run(root);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /journeys\/broken\.ts\(1,14\): error TS2322/);
});

test("a layer with a verify.config.ts and no tsconfig.json fails and names the fix", (t) => {
  const root = checksRepo(t);
  put(root, `${LAYER}/verify.config.ts`, CLEAN_SOURCE);
  const result = run(root);
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /\[verify:types\]\n\.agents\/skills\/verify-interface: has a verify\.config\.ts and no tsconfig\.json\. Run antelopejs-sync/,
  );
});

test("each layer is checked on its own, so one broken layer fails among clean ones", (t) => {
  const root = layerRepo(t, CLEAN_SOURCE);
  const other = skillFolder("module");
  for (const { path, content } of syncedFiles("module"))
    if (path.endsWith("tsconfig.json")) put(root, path, content);
  put(root, `${other}/verify.config.ts`, BROKEN_SOURCE);
  const result = run(root);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /verify-module\/verify\.config\.ts\(1,14\)/);
  assert.doesNotMatch(result.stdout, /verify-interface/);
});

test("ANTELOPEJS_CHECKS_SKIP names verify:types and verify:lockfiles, and a skipped step is not run", (t) => {
  const root = layerRepo(t, BROKEN_SOURCE);
  put(root, `${LAYER}/package.json`, WITH_DEPENDENCY);
  put(root, `${LAYER}/pnpm-lock.yaml`, PNPM_LOCK_WITHOUT_DEPENDENCIES);
  const result = run(root, {
    ANTELOPEJS_CHECKS_SKIP: "verify:types,verify:lockfiles",
  });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "Checks: 8 passed, 0 failed, 2 skipped.\n");
});

/** Runs the checks with the layer type-check skipped, so the lockfile tests do not pay for a compiler run. */
function lockfiles(root: string, env: Record<string, string> = {}) {
  return run(root, { ...env, ANTELOPEJS_CHECKS_SKIP: "verify:types" });
}

test("a stale pnpm lockfile in a verify layer fails, names the fix and is left unchanged", (t) => {
  const root = layerRepo(t, CLEAN_SOURCE);
  put(root, `${LAYER}/package.json`, WITH_DEPENDENCY);
  put(root, `${LAYER}/pnpm-lock.yaml`, PNPM_LOCK_WITHOUT_DEPENDENCIES);
  const result = lockfiles(root);
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /\[verify:lockfiles\]\n\.agents\/skills\/verify-interface\/pnpm-lock\.yaml does not match \.agents\/skills\/verify-interface\/package\.json: run `pnpm install --dir \.agents\/skills\/verify-interface --ignore-workspace --lockfile-only`\./,
  );
  assert.equal(
    read(root, `${LAYER}/pnpm-lock.yaml`),
    PNPM_LOCK_WITHOUT_DEPENDENCIES,
  );
  assert.match(result.stdout, /Checks: 8 passed, 1 failed, 1 skipped\.\n$/);
});

test("a matching pnpm lockfile in a verify layer passes", (t) => {
  const root = layerRepo(t, CLEAN_SOURCE);
  put(root, `${LAYER}/package.json`, NO_DEPENDENCIES);
  put(root, `${LAYER}/pnpm-lock.yaml`, PNPM_LOCK_WITHOUT_DEPENDENCIES);
  const result = lockfiles(root);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "Checks: 9 passed, 0 failed, 1 skipped.\n");
});

test("a stale lockfile in a nested folder of the layer, like its playground, fails", (t) => {
  const root = layerRepo(t, CLEAN_SOURCE);
  put(root, `${LAYER}/playground/package.json`, WITH_DEPENDENCY);
  put(
    root,
    `${LAYER}/playground/pnpm-lock.yaml`,
    PNPM_LOCK_WITHOUT_DEPENDENCIES,
  );
  const result = lockfiles(root);
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /\[verify:lockfiles\]\n\.agents\/skills\/verify-interface\/playground\/pnpm-lock\.yaml does not match/,
  );
});

test("a stale lockfile in the root playground fails when a verify layer exists", (t) => {
  const root = layerRepo(t, CLEAN_SOURCE);
  put(root, "playground/package.json", WITH_DEPENDENCY);
  put(root, "playground/pnpm-lock.yaml", PNPM_LOCK_WITHOUT_DEPENDENCIES);
  const result = lockfiles(root);
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /\[verify:lockfiles\]\nplayground\/pnpm-lock\.yaml does not match playground\/package\.json/,
  );
});

test("a stale lockfile of the root package does not fail: only folders verify installs from are replayed", (t) => {
  const root = layerRepo(t, CLEAN_SOURCE);
  put(root, "package-lock.json", "{}");
  put(root, "pnpm-lock.yaml", "broken: [\n");
  const result = lockfiles(root);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "Checks: 8 passed, 0 failed, 1 skipped.\n");
});

test("a package-lock.json in a verify layer is replayed with npm and passes when it matches", (t) => {
  const root = layerRepo(t, CLEAN_SOURCE);
  put(root, `${LAYER}/package.json`, WITH_DEPENDENCY);
  put(root, `${LAYER}/package-lock.json`, NPM_LOCK_WITH_DEPENDENCY);
  const result = lockfiles(root, { npm_config_offline: "true" });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "Checks: 9 passed, 0 failed, 1 skipped.\n");
});

test("a stale package-lock.json in a verify layer fails", (t) => {
  const root = layerRepo(t, CLEAN_SOURCE);
  put(
    root,
    `${LAYER}/package.json`,
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      private: true,
      dependencies: { "left-pad": "^2.0.0" },
    }),
  );
  put(root, `${LAYER}/package-lock.json`, NPM_LOCK_WITH_DEPENDENCY);
  const result = lockfiles(root, { npm_config_offline: "true" });
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /\[verify:lockfiles\]\n\.agents\/skills\/verify-interface/,
  );
});
