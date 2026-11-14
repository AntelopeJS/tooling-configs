import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { apiRepo, bin, commit, put } from "./helpers/test-repo.ts";

test("api-diff expands slash-spanning exports, all conditions, main and typesVersions, and rejects a removed entry", (t) => {
  const root = apiRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({
      name: "public-api",
      type: "module",
      scripts: {
        build: "tsc --noEmit false --composite false --declarationMap false",
      },
      exports: {
        "./*": "./dist/features/*.js",
        "./dual": { import: "./dist/esm.mjs", require: "./dist/cjs.cjs" },
      },
      main: "./dist/main.js",
      typings: "./dist/main.d.ts",
      typesVersions: { "*": { compat: ["dist/compat/*.d.ts"] } },
    }),
  );
  for (const path of [
    "features/nested/entry.ts",
    "esm.mts",
    "cjs.cts",
    "main.ts",
    "compat/old.ts",
  ])
    put(root, `src/${path}`, "export interface Value { value: string }\n");
  commit(root);
  const same = bin(root, "api-diff", ["HEAD"]);
  assert.equal(same.status, 0, same.stdout + same.stderr);
  assert.match(same.stdout, /1 packages, 6 entries unchanged/);
  rmSync(join(root, "src/features/nested/entry.ts"));
  commit(root);
  const removed = bin(root, "api-diff", ["HEAD~1"]);
  assert.equal(removed.status, 1);
  assert.match(
    removed.stdout,
    /^-\/\/ {3}_root\/exports\/subpath\/nested%2Fentry\.d\.ts$/mu,
  );
});

test("api-diff leaves compiled test files out of wildcard exports in both halves", (t) => {
  const root = apiRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({
      name: "public-api",
      type: "module",
      scripts: {
        build: "tsc --noEmit false --composite false --declarationMap false",
      },
      exports: { "./*": "./dist/*.js" },
    }),
  );
  put(
    root,
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2020",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        rootDir: "src",
        outDir: "dist",
        types: [],
        strict: true,
        noEmit: true,
        declarationMap: true,
        composite: true,
      },
      include: ["src/**/*"],
    }),
  );
  put(root, "src/feature.ts", "export const value = 1;\n");
  put(
    root,
    "src/tests/feature.test.ts",
    'declare function describe(name: string, body: () => void): void;\ndescribe("feature", () => {});\nexport {};\n',
  );
  commit(root);
  const result = bin(root, "api-diff", ["HEAD"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Runtime API: 1 packages, 1 entries unchanged/);
  assert.match(result.stdout, /^API: 1 packages, 1 entries unchanged/);
});

test("api-diff compares published subpaths, allowing entry relocation but catching a removed alias of the same declaration", (t) => {
  const root = apiRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({
      type: "module",
      scripts: {
        build: "tsc --noEmit false --composite false --declarationMap false",
      },
      exports: { "./before": "./dist/index.js" },
    }),
  );
  put(root, "src/index.ts", "export interface Shape { value: string }\n");
  commit(root);
  execFileSync("git", ["tag", "base"], { cwd: root });
  put(
    root,
    "package.json",
    JSON.stringify({
      type: "module",
      scripts: {
        build: "tsc --noEmit false --composite false --declarationMap false",
      },
      exports: { "./after": "./dist/index.js" },
    }),
  );
  commit(root);
  const alias = bin(root, "api-diff", ["base"]);
  assert.equal(alias.status, 1, alias.stderr);
  assert.match(alias.stdout, /deleted file mode/);
  put(
    root,
    "package.json",
    JSON.stringify({
      type: "module",
      scripts: {
        build: "tsc --noEmit false --composite false --declarationMap false",
      },
      exports: { "./before": "./dist/moved.js" },
    }),
  );
  rmSync(join(root, "src/index.ts"));
  put(root, "src/moved.ts", "export interface Shape { value: string }\n");
  commit(root);
  const moved = bin(root, "api-diff", ["base"]);
  assert.equal(moved.status, 0, moved.stdout + moved.stderr);
});

function exportsOf(names: readonly string[]): string {
  return JSON.stringify({
    name: "public-api",
    type: "module",
    exports: Object.fromEntries(
      names.map((name) => [
        name === "index" ? "." : `./${name}`,
        { types: `./dist/${name}.d.ts`, default: `./dist/${name}.js` },
      ]),
    ),
  });
}

function members(changed: readonly string[]): string {
  return Array.from({ length: 16 }, (_, index) => {
    const name = `m${String(index + 1).padStart(2, "0")}`;
    return `${name}: ${changed.includes(name) ? "number" : "string"};`;
  }).join(" ");
}

test("api-diff prints a declaration changed in several entries once, naming its entries once, and an added or removed declaration under its own entries", (t) => {
  const root = apiRepo(t);
  put(root, "package.json", exportsOf(["index", "extra", "other"]));
  put(root, "src/shared.ts", `export interface Value { ${members([])} }\n`);
  put(root, "src/index.ts", 'export type { Value } from "./shared.js";\n');
  put(root, "src/extra.ts", 'export type { Value } from "./shared.js";\n');
  const zed = "export interface Zed { zed: string }\n";
  put(root, "src/other.ts", `export interface Other { other: string }\n${zed}`);
  commit(root);
  put(
    root,
    "src/shared.ts",
    `export interface Value { ${members(["m04", "m12"])} }\n`,
  );
  commit(root);
  const changed = bin(root, "api-diff", ["HEAD~1"]);
  assert.equal(changed.status, 1, changed.stdout + changed.stderr);
  assert.deepEqual(changed.stdout.match(/^[-+](?![-+]).*$/gmu), [
    "-    m04: string;",
    "+    m04: number;",
    "-    m12: string;",
    "+    m12: number;",
  ]);
  assert.deepEqual(
    changed.stdout
      .match(/^@@ .*$/gmu)
      ?.map((header) => header.split(" @@ ")[1]),
    [
      "export interface Value { // In _root/exports/root.d.ts, _root/exports/subpath/extra.d.ts",
      "export interface Value {",
    ],
  );
  put(root, "package.json", exportsOf(["index", "extra", "more", "other"]));
  put(root, "src/more.ts", 'export type { Value } from "./shared.js";\n');
  commit(root);
  const added = bin(root, "api-diff", ["HEAD~1"]);
  assert.equal(added.status, 1, added.stdout + added.stderr);
  assert.deepEqual(added.stdout.match(/^[-+](?![-+]).*$/gmu), [
    "+//   _root/exports/subpath/more.d.ts",
    "+// In _root/exports/subpath/more.d.ts",
  ]);
  put(root, "src/other.ts", "export interface Other { other: string }\n");
  commit(root);
  const removed = bin(root, "api-diff", ["HEAD~1"]);
  assert.equal(removed.status, 1, removed.stdout + removed.stderr);
  assert.match(removed.stdout, /^-export interface Zed \{$/mu);
  assert.doesNotMatch(removed.stdout, /^@@ .*\/\/ In/mu);
});
