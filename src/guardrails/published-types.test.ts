import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test, { type TestContext } from "node:test";

import { bin, put, testRepo } from "./helpers/test-repo.ts";
import type { ExportTarget } from "./package.ts";
import { typedPackages } from "./published-types.ts";
import { shimInvocation } from "./run-command.ts";

/** Every step but `published:types`, so it alone decides the run. */
const OTHER_STEPS =
  "typecheck,lint,format:check,knip,test,size,suppressions,sync:check,git:identity,lockfile:singletons";

/** The `package.json` fields a fixture sets beside its name, version and `types`. */
interface FixtureFields {
  packageManager?: string;
  exports?: ExportTarget;
  files?: string[];
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional: boolean }>;
  scripts?: Record<string, string>;
}

function typedRepo(
  t: TestContext,
  manifest: FixtureFields,
  files: Record<string, string>,
): string {
  const root = testRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({
      name: "@fixture/typed",
      version: "1.0.0",
      packageManager: "pnpm@10.2.0",
      types: "index.d.ts",
      ...manifest,
    }),
  );
  for (const [path, content] of Object.entries(files)) put(root, path, content);
  return root;
}

function checks(root: string) {
  return bin(root, "checks", ["--no-services"], {
    ANTELOPEJS_CHECKS_SKIP: OTHER_STEPS,
  });
}

test("a declaration importing a package the tarball does not depend on fails checks and names the file, caught by an implementation that runs tsc with skipLibCheck on", (t) => {
  const root = typedRepo(
    t,
    {},
    {
      "index.d.ts":
        'import type { Claims } from "not-a-dependency";\nexport declare const claims: Claims;\n',
    },
  );
  const result = checks(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /^\[published:types\]\npackage\.json: @fixture\/typed as a consumer installs it, checked by tsc with skipLibCheck off:\n@fixture\/typed\/index\.d\.ts\(1,\d+\): error TS2307: Cannot find module 'not-a-dependency'/,
  );
  assert.match(result.stdout, /Checks: 0 passed, 1 failed, 9 skipped\.\n$/);
});

test("a declaration importing a file that package.json files leaves out of the tarball fails checks, caught by an implementation that typechecks the working tree instead of the packed package", (t) => {
  const root = typedRepo(
    t,
    { files: ["index.d.ts"] },
    {
      "index.d.ts":
        'import type { Claims } from "./claims.js";\nexport declare const claims: Claims;\n',
      "claims.d.ts": "export interface Claims { sub: string }\n",
    },
  );
  const result = checks(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /@fixture\/typed\/index\.d\.ts\(1,\d+\): error TS2307: Cannot find module '\.\/claims\.js'/,
  );
});

test("a declaration importing an optional peer passes checks, caught by an implementation that installs the tarball without its optional peers", (t) => {
  const root = typedRepo(
    t,
    {
      peerDependencies: { yaml: "^2.0.0" },
      peerDependenciesMeta: { yaml: { optional: true } },
    },
    {
      "index.d.ts":
        'import type { Document } from "yaml";\nexport declare const document: Document;\n',
    },
  );
  const result = checks(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, "Checks: 1 passed, 0 failed, 9 skipped.\n");
});

test("typedPackages lists a typed workspace member beside a private root and skips an untyped and a private member, caught by an implementation that reads only the root package", (t) => {
  const root = testRepo(t);
  put(root, "package.json", JSON.stringify({ name: "root", private: true }));
  put(root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  const members = {
    typed: { name: "@fixture/typed", exports: { ".": { types: "./a.d.ts" } } },
    untyped: { name: "@fixture/untyped", main: "index.js" },
    hidden: { name: "@fixture/hidden", private: true, types: "a.d.ts" },
  };
  for (const [directory, manifest] of Object.entries(members))
    put(root, `packages/${directory}/package.json`, JSON.stringify(manifest));
  assert.deepEqual(typedPackages(root), [
    { directory: "packages/typed", name: "@fixture/typed" },
  ]);
});

test("a typed package in an npm repository passes checks, caught by an implementation that packs into a folder npm pack does not create", (t) => {
  const root = typedRepo(
    t,
    { packageManager: "npm@11.0.0" },
    { "index.d.ts": "export declare const count: number;\n" },
  );
  const result = checks(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, "Checks: 1 passed, 0 failed, 9 skipped.\n");
});

for (const packageManager of ["pnpm@10.2.0", "npm@11.0.0"])
  test(`a ${packageManager} package whose prepack writes its declaration and whose prepare fails passes checks, caught by an implementation that lets pack run lifecycle scripts, which pnpm pack runs through cmd.exe on Windows, or that skips prepack`, (t) => {
    const root = typedRepo(
      t,
      {
        packageManager,
        scripts: {
          prepack: `node -e "require('fs').writeFileSync('index.d.ts','export declare const count: number;')"`,
          prepare: "exit 1",
        },
      },
      {},
    );
    const result = checks(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, "Checks: 1 passed, 0 failed, 9 skipped.\n");
  });

test("a declaration using the compiler API of a typescript peer passes checks, caught by an implementation that installs the latest typescript over the peer's range", (t) => {
  const root = typedRepo(
    t,
    { peerDependencies: { typescript: "^5.0.0" } },
    {
      "index.d.ts":
        'import type { SourceFile } from "typescript";\nexport declare function parse(text: string): SourceFile;\n',
    },
  );
  const result = checks(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, "Checks: 1 passed, 0 failed, 9 skipped.\n");
});

test("a workspace package using a type its unpublished sibling adds passes checks, caught by an implementation that installs the sibling from the registry", (t) => {
  const root = testRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({
      name: "root",
      private: true,
      packageManager: "pnpm@10.2.0",
    }),
  );
  put(root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  put(
    root,
    "packages/claims/package.json",
    JSON.stringify({
      name: "@fixture-unpublished/claims",
      version: "1.0.0",
      types: "index.d.ts",
    }),
  );
  put(
    root,
    "packages/claims/index.d.ts",
    "export interface Claims { sub: string }\n",
  );
  put(
    root,
    "packages/auth/package.json",
    JSON.stringify({
      name: "@fixture-unpublished/auth",
      version: "1.0.0",
      types: "index.d.ts",
      dependencies: { "@fixture-unpublished/claims": "workspace:^" },
    }),
  );
  put(
    root,
    "packages/auth/index.d.ts",
    'import type { Claims } from "@fixture-unpublished/claims";\nexport declare const claims: Claims;\n',
  );
  const install = shimInvocation("pnpm", ["install", "--silent"]);
  execFileSync(install.command, install.args, {
    cwd: root,
    shell: install.shell,
  });
  const result = checks(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, "Checks: 1 passed, 0 failed, 10 skipped.\n");
});

test("checks reports an error in a file a wildcard export reaches and none in a shipped file no export reaches, caught by an implementation that checks every shipped declaration or skips wildcard subpaths", (t) => {
  const broken =
    'import type { Missing } from "not-a-dependency";\nexport declare const value: Missing;\n';
  const root = typedRepo(
    t,
    {
      exports: {
        ".": { types: "./index.d.ts", default: "./index.js" },
        "./parts/*": { types: "./parts/*.d.ts", default: "./parts/*.js" },
      },
    },
    {
      "index.d.ts": "export declare const count: number;\n",
      "index.js": "export const count = 1;\n",
      "parts/broken.d.ts": broken,
      "parts/broken.js": "export const value = 1;\n",
      "layer/unexported.d.ts": broken,
    },
  );
  const result = checks(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /@fixture\/typed\/parts\/broken\.d\.ts\(1,\d+\): error TS2307/,
  );
  assert.doesNotMatch(result.stdout, /unexported/);
});

test("an exports types target the tarball does not ship fails checks, caught by an implementation that only checks the declaration files the tarball holds", (t) => {
  const root = typedRepo(
    t,
    {
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      },
    },
    {
      "dist/index.js": "export const count = 1;\n",
      "dist/main.d.ts": "export declare const count: number;\n",
    },
  );
  const result = checks(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /consumer\.mts\(1,\d+\): error TS7016: Could not find a declaration file for module '@fixture\/typed'/,
  );
});

test("checks reports a broken declaration only require reaches and none for a subpath a null pattern hides, a stylesheet or a script without declarations, caught by an implementation that resolves one ESM condition set or expands a pattern past a more specific key", (t) => {
  const root = typedRepo(
    t,
    {
      exports: {
        ".": {
          import: { types: "./index.d.mts", default: "./index.mjs" },
          require: { types: "./index.d.cts", default: "./index.cjs" },
        },
        "./*": { types: "./dist/*.d.ts", default: "./dist/*.js" },
        "./internal/*": null,
        "./register": "./register.js",
        "./style.css": "./style.css",
      },
    },
    {
      "index.d.mts": "export declare const count: number;\n",
      "index.d.cts": "export declare const count: Missing;\n",
      "dist/part.d.ts": "export declare const part: number;\n",
      "dist/internal/secret.d.ts": "export declare const secret: number;\n",
      "register.js": "globalThis.registered = true;\n",
      "style.css": "body {}\n",
    },
  );
  const result = checks(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /@fixture\/typed\/index\.d\.cts\(1,\d+\): error TS2304: Cannot find name 'Missing'/,
  );
  assert.doesNotMatch(result.stdout, /internal|register|style|part/);
});

test("a package that only CommonJS can require passes checks, caught by an implementation that only imports it as an ES module", (t) => {
  const root = typedRepo(
    t,
    {
      exports: {
        ".": { require: { types: "./index.d.cts", default: "./index.cjs" } },
      },
    },
    { "index.d.cts": "export declare const count: number;\n" },
  );
  const result = checks(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, "Checks: 1 passed, 0 failed, 9 skipped.\n");
});

test("workspace packages that depend on each other pass checks, caught by an implementation that lets a sibling pull the checked package from the registry", (t) => {
  const root = testRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({
      name: "root",
      private: true,
      packageManager: "pnpm@10.2.0",
    }),
  );
  put(root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  for (const [own, other] of [
    ["first", "second"],
    ["second", "first"],
  ]) {
    put(
      root,
      `packages/${own}/package.json`,
      JSON.stringify({
        name: `@fixture-unpublished/${own}`,
        version: "1.0.0",
        types: "index.d.ts",
        dependencies: { [`@fixture-unpublished/${other}`]: "workspace:*" },
      }),
    );
    put(
      root,
      `packages/${own}/index.d.ts`,
      `export interface ${own === "first" ? "First" : "Second"} { id: string }\n`,
    );
  }
  const install = shimInvocation("pnpm", ["install", "--silent"]);
  execFileSync(install.command, install.args, {
    cwd: root,
    shell: install.shell,
  });
  const result = checks(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, "Checks: 1 passed, 0 failed, 10 skipped.\n");
});

test("a broken declaration behind a types condition listed after import and require fails checks, caught by an implementation that stops at the first matching condition", (t) => {
  const root = typedRepo(
    t,
    {
      exports: {
        ".": {
          import: "./esm/index.js",
          require: "./cjs/index.cjs",
          types: "./types/index.d.ts",
        },
      },
    },
    {
      "esm/index.js": "export const count = 1;\n",
      "cjs/index.cjs": "exports.count = 1;\n",
      "types/index.d.ts": "export declare const count: Missing;\n",
    },
  );
  const result = checks(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /@fixture\/typed\/types\/index\.d\.ts\(1,\d+\): error TS2304: Cannot find name 'Missing'/,
  );
});

test("a suffix-less pattern beside a longer null pattern passes checks, caught by an implementation that imports declaration files by name or breaks a pattern tie by key order", (t) => {
  const root = typedRepo(
    t,
    { exports: { "./*": "./dist/*", "./*.d.ts": null } },
    {
      "dist/part.js": "export const part = 1;\n",
      "dist/part.d.ts": "export declare const part: number;\n",
    },
  );
  const result = checks(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, "Checks: 1 passed, 0 failed, 9 skipped.\n");
});
