import assert from "node:assert/strict";
import { existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { skillFolder } from "../verify/kinds.ts";
import { syncedFiles } from "../verify/skills.ts";
import { PACKAGE_ROOT, bin, put, testRepo } from "./helpers/test-repo.ts";
import {
  NO_DEPENDENCIES,
  folderStamp,
  npmLock,
  pnpmLock,
} from "./helpers/lockfiles.ts";

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
const LEFT_PAD = { "left-pad": "^1.3.0" };
/** An environment in which every registry, proxy and package manager download is unreachable. */
const OFFLINE = {
  npm_config_registry: "http://127.0.0.1:9/",
  NPM_CONFIG_REGISTRY: "http://127.0.0.1:9/",
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  COREPACK_NPM_REGISTRY: "http://127.0.0.1:9/",
};

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
        incremental: true,
        tsBuildInfoFile: "./.cache/root.tsbuildinfo",
        declaration: true,
        types: [],
      },
      include: ["src"],
    }),
  );
  put(root, "src/index.ts", "export const value = 1;\n");
  return root;
}

function layerRepo(t: TestContext, source: string): string {
  const root = checksRepo(t);
  for (const { path, content } of syncedFiles("interface"))
    if (path.endsWith("tsconfig.json")) put(root, path, content);
  put(root, `${LAYER}/verify.config.ts`, source);
  return root;
}

function run(root: string, env: Record<string, string> = {}) {
  return bin(root, "checks", ["--no-services"], env);
}

/** Runs the checks with the layer type-check skipped, so the lockfile tests do not pay for a compiler run. */
function lockfiles(root: string, env: Record<string, string> = {}) {
  return run(root, { ...env, ANTELOPEJS_CHECKS_SKIP: "verify:types" });
}

test("a layer type error fails under verify:types with the compiler error, caught by an implementation that compiles nothing", (t) => {
  const result = run(layerRepo(t, BROKEN_SOURCE));
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /\[verify:types\]\n[^\n]*verify\.config\.ts\(1,14\): error TS2322/,
  );
  assert.match(result.stdout, /Checks: 8 passed, 1 failed\.\n$/);
});

test("a clean layer passes and writes nothing, caught by an implementation that keeps the root's incremental build or writes its config in the layer", (t) => {
  const root = layerRepo(t, CLEAN_SOURCE);
  const before = folderStamp(join(root, LAYER), "verify.config.ts");
  const result = run(root);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "Checks: 9 passed, 0 failed.\n");
  assert.deepEqual(folderStamp(join(root, LAYER), "verify.config.ts"), before);
  assert.equal(existsSync(join(root, ".cache")), false);
});

test("a type error in the layer's playground, dist or node_modules is ignored, caught by an implementation that checks every file the layer tsconfig includes", (t) => {
  const root = layerRepo(t, CLEAN_SOURCE);
  put(root, `${LAYER}/playground/src/index.ts`, BROKEN_SOURCE);
  put(root, `${LAYER}/journeys/dist/built.ts`, BROKEN_SOURCE);
  const result = run(root);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "Checks: 9 passed, 0 failed.\n");
});

test("a type error in a layer file other than verify.config.ts fails, caught by an implementation that checks only verify.config.ts", (t) => {
  const root = layerRepo(t, CLEAN_SOURCE);
  put(root, `${LAYER}/journeys/broken.ts`, BROKEN_SOURCE);
  const result = run(root);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /journeys\/broken\.ts\(1,14\): error TS2322/);
});

test("a layer whose code imports Node APIs type-checks against the repository's @types/node, caught by a generated config that loses the layer's type roots", (t) => {
  const root = layerRepo(
    t,
    'import { join } from "node:path";\n\nexport const path: string = join("a", "b");\n',
  );
  const result = run(root);
  assert.equal(result.status, 0, result.stdout);
});

test("a layer inheriting declarationDir, isolatedDeclarations and declarationMap passes, caught by a generated config that unsets declaration and leaves the options that need it", (t) => {
  const root = layerRepo(t, CLEAN_SOURCE);
  put(
    root,
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        declaration: true,
        declarationDir: "./types",
        declarationMap: true,
        isolatedDeclarations: true,
        emitDeclarationOnly: true,
        incremental: true,
        tsBuildInfoFile: "./.cache/root.tsbuildinfo",
        types: [],
      },
      include: ["src"],
    }),
  );
  const result = run(root);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "Checks: 9 passed, 0 failed.\n");
  assert.equal(existsSync(join(root, ".cache")), false);
});

test("layer code that only declaration emit rejects passes, caught by a generated config that keeps the declaration: true the layer inherits", (t) => {
  const root = layerRepo(
    t,
    "class Base {\n  private secret = 1;\n}\n\nexport function make() {\n  return new (class extends Base {})();\n}\n",
  );
  const result = run(root);
  assert.equal(result.status, 0, result.stdout);
});

test("a layer tsconfig that does not include verify.config.ts fails and names the fix, caught by an implementation that checks only the files the tsconfig lists", (t) => {
  const root = layerRepo(t, BROKEN_SOURCE);
  put(
    root,
    `${LAYER}/tsconfig.json`,
    JSON.stringify({
      extends: "../../../tsconfig.json",
      compilerOptions: { rootDir: "../../..", noEmit: true },
      include: ["journeys/**/*.ts"],
    }),
  );
  put(root, `${LAYER}/journeys/clean.ts`, CLEAN_SOURCE);
  const result = run(root);
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /\[verify:types\]\n\.agents\/skills\/verify-interface\/tsconfig\.json: does not include verify\.config\.ts, so it is never type-checked\./,
  );
});

test("a layer with a verify.config.ts and no tsconfig.json fails and names the fix, caught by an implementation that skips it", (t) => {
  const root = checksRepo(t);
  put(root, `${LAYER}/verify.config.ts`, CLEAN_SOURCE);
  const result = run(root);
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /\[verify:types\]\n\.agents\/skills\/verify-interface: has a verify\.config\.ts and no tsconfig\.json\./,
  );
});

test("each layer is checked on its own, caught by an implementation that reports one layer's errors under another", (t) => {
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

test("a repository without a verify layer runs exactly the steps it did before, caught by an implementation that checks a root playground on its own", (t) => {
  const root = checksRepo(t);
  put(root, ".agents/skills/unslop/SKILL.md", "---\nname: unslop\n---\n");
  put(
    root,
    "playground/package.json",
    JSON.stringify({ ...NO_DEPENDENCIES, dependencies: LEFT_PAD }),
  );
  put(root, "playground/pnpm-lock.yaml", "not a lockfile: [\n");
  const result = run(root, { ANTELOPEJS_CHECKS_SKIP: "lockfile:singletons" });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "Checks: 8 passed, 0 failed, 1 skipped.\n");
});

test("ANTELOPEJS_CHECKS_SKIP names verify:types and verify:lockfiles, caught by an implementation that runs a skipped step", (t) => {
  const root = layerRepo(t, BROKEN_SOURCE);
  put(
    root,
    `${LAYER}/package.json`,
    JSON.stringify({ ...NO_DEPENDENCIES, dependencies: LEFT_PAD }),
  );
  put(root, `${LAYER}/pnpm-lock.yaml`, pnpmLock({ ".": {} }));
  const result = run(root, {
    ANTELOPEJS_CHECKS_SKIP: "verify:types,verify:lockfiles",
  });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "Checks: 9 passed, 0 failed, 2 skipped.\n");
});

test("a stale layer lockfile fails under verify:lockfiles and names the dependency and the fix, caught by an implementation that never compares", (t) => {
  const root = layerRepo(t, CLEAN_SOURCE);
  put(
    root,
    `${LAYER}/package.json`,
    JSON.stringify({ ...NO_DEPENDENCIES, dependencies: LEFT_PAD }),
  );
  put(root, `${LAYER}/pnpm-lock.yaml`, pnpmLock({ ".": {} }));
  const result = lockfiles(root);
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /\[verify:lockfiles\]\n\.agents\/skills\/verify-interface\/pnpm-lock\.yaml does not match \.agents\/skills\/verify-interface\/package\.json: run `pnpm install --dir \.agents\/skills\/verify-interface --ignore-workspace --lockfile-only`\.\n {2}importer "\." "left-pad": package\.json asks for "\^1\.3\.0", the lockfile has none\.\n/,
  );
  assert.match(result.stdout, /Checks: 9 passed, 1 failed, 1 skipped\.\n$/);
});

for (const [manager, file, lock, passed] of [
  ["pnpm", "pnpm-lock.yaml", pnpmLock({ ".": { dependencies: LEFT_PAD } }), 10],
  ["npm", "package-lock.json", npmLock({ dependencies: LEFT_PAD }), 9],
] as const)
  test(`a matching ${manager} lockfile passes with every registry unreachable and leaves its folder untouched, caught by an implementation that runs ${manager} or rewrites the lockfile`, (t) => {
    const root = layerRepo(t, CLEAN_SOURCE);
    const folder = join(root, `${LAYER}/playground`);
    put(
      root,
      `${LAYER}/playground/package.json`,
      JSON.stringify({
        ...NO_DEPENDENCIES,
        packageManager: `${manager}@10.0.0`,
        dependencies: LEFT_PAD,
      }),
    );
    put(root, `${LAYER}/playground/${file}`, lock);
    const before = folderStamp(folder, file);
    const result = lockfiles(root, OFFLINE);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(
      result.stdout,
      `Checks: ${passed} passed, 0 failed, 1 skipped.\n`,
    );
    assert.deepEqual(folderStamp(folder, file), before);
    assert.equal(before.nodeModules, false);
  });
