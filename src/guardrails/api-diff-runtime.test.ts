import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { apiRepo, bin, commit, put, read } from "./helpers/test-repo.ts";
import type { Manifest } from "./package.ts";

test("api-diff detects a CJS getter re-export with identical declarations and compares a captured probe", (t) => {
  const root = apiRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({
      name: "getter-api",
      scripts: {
        build: "tsc --noEmit false --composite false --declarationMap false",
      },
      main: "dist/index.js",
    }),
  );
  put(
    root,
    "src/launch.ts",
    "export async function launch(): Promise<void> {}\n",
  );
  put(
    root,
    "src/index.ts",
    "export async function launch(): Promise<void> {}\n",
  );
  commit(root);
  execFileSync("git", ["tag", "base"], { cwd: root });
  put(root, "src/index.ts", 'export { launch } from "./launch";\n');
  commit(root);
  const metadata = bin(root, "api-diff", ["base"]);
  assert.equal(metadata.status, 1, metadata.stdout + metadata.stderr);
  assert.match(metadata.stdout, /API: 1 packages, 1 entries unchanged/);
  assert.match(metadata.stdout, /Runtime API: differences/);
  assert.match(metadata.stdout, /"key": "launch"/);
  assert.match(metadata.stdout, /No behavioural probe ran/);
  put(
    root,
    "probe.cjs",
    'const api = require(require("node:path").join(process.argv[2], "dist/index.js")); process.stdout.write(JSON.stringify(Reflect.set(api, "launch", api.launch)));',
  );
  const probed = bin(root, "api-diff", ["base", "--probe", "probe.cjs"]);
  assert.equal(probed.status, 1, probed.stdout + probed.stderr);
  assert.match(probed.stdout, /diff --git a\/base\/probe.json/);
  assert.match(probed.stdout, /-true\n\+false/);
});

test("api-diff inspects getter values once, never invokes class accessors, and detects async, arity, constructibility and member changes", (t) => {
  const root = apiRepo(t);
  put(root, "src/index.ts", "export interface Public {}\n");
  put(
    root,
    "package.json",
    JSON.stringify({
      main: "dist/index.js",
      scripts: {
        build:
          "tsc --noEmit false --composite false --declarationMap false && node build.cjs",
      },
    }),
  );
  const before =
    'let reads = 0; class Service { static get untouched() { throw Error("do not invoke"); } async restore(arg) {} } Object.defineProperty(exports, "Service", { get() { if (++reads > 1) throw Error("read twice"); return Service; } }); exports.make = function make(arg) {};';
  const after = before
    .replace("async restore(arg)", "restore()")
    .replace("function make(arg) {}", "(arg) => {}");
  put(
    root,
    "build.cjs",
    `require("node:fs").writeFileSync("dist/index.js", ${JSON.stringify(before)});`,
  );
  commit(root);
  assert.equal(bin(root, "api-diff", ["HEAD"]).status, 0);
  put(
    root,
    "build.cjs",
    `require("node:fs").writeFileSync("dist/index.js", ${JSON.stringify(after)});`,
  );
  commit(root);
  const result = bin(root, "api-diff", ["HEAD~1"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /API: 1 packages, 1 entries unchanged/);
  assert.match(result.stdout, /-.*"async": true/);
  assert.match(result.stdout, /\+.*"length": 0/);
  assert.match(result.stdout, /\+.*"constructible": false/);
  for (const source of [
    'module.exports = class Service { static get untouched() { throw Error("do not invoke"); } };',
    "module.exports = 42;",
  ]) {
    put(
      root,
      "build.cjs",
      `require("node:fs").writeFileSync("dist/index.js", ${JSON.stringify(source)});`,
    );
    commit(root);
    const direct = bin(root, "api-diff", ["HEAD"]);
    assert.equal(direct.status, 0, direct.stdout + direct.stderr);
  }
});

test("api-diff builds each revision against its own workspace packages, dependencies first, and still resolves their declarations", (t) => {
  const root = apiRepo(t);
  put(root, ".gitignore", "node_modules\ndist\n");
  put(
    root,
    "package.json",
    JSON.stringify({ private: true, workspaces: ["packages/*"] }),
  );
  const tsconfig = JSON.parse(read(root, "tsconfig.json"));
  const build = (version: number) =>
    `const { writeFileSync, mkdirSync } = require("node:fs"); mkdirSync("dist", { recursive: true }); writeFileSync("dist/index.js", "exports.version = ${version};"); writeFileSync("dist/index.d.ts", "export declare const version: ${version};");`;
  const revision = (version: number) => {
    put(root, "packages/lib/build.cjs", build(version));
    put(
      root,
      "packages/app/build.cjs",
      `const { version } = require("lib"); if (version !== ${version}) throw new Error("built against lib " + version); require("node:fs").mkdirSync("dist", { recursive: true }); require("node:fs").writeFileSync("dist/index.js", "exports.v" + version + " = true;");`,
    );
    commit(root);
  };
  for (const name of ["lib", "app"]) {
    put(root, `packages/${name}/tsconfig.json`, JSON.stringify(tsconfig));
    put(
      root,
      `packages/${name}/package.json`,
      JSON.stringify({
        name,
        main: "dist/index.js",
        types: "dist/index.d.ts",
        scripts: { build: "node build.cjs" },
        dependencies: name === "app" ? { lib: "workspace:*" } : {},
      }),
    );
  }
  put(
    root,
    "packages/lib/src/index.ts",
    "export declare const version: number;\n",
  );
  put(
    root,
    "packages/app/src/index.ts",
    'import { version } from "lib";\nexport const fromLib: number = version;\n',
  );
  revision(1);
  execFileSync("git", ["tag", "base"], { cwd: root });
  revision(2);
  execFileSync(process.execPath, ["build.cjs"], {
    cwd: join(root, "packages/lib"),
  });
  mkdirSync(join(root, "packages/app/node_modules"));
  const lib = join(root, "packages/app/node_modules/lib");
  if (process.platform === "win32")
    symlinkSync(join(root, "packages/lib"), lib, "junction");
  else symlinkSync("../../lib", lib, "dir");
  const result = bin(root, "api-diff", ["base"]);
  assert.doesNotMatch(result.stdout, /Execution error/);
  assert.match(result.stdout, /^API: 2 packages, \d+ entries unchanged/m);
  assert.match(result.stdout, /^-.*"key": "v1"/m);
  assert.match(result.stdout, /^\+.*"key": "v2"/m);
});

test("api-diff resolves a workspace package that moved since the base to the base's own copy", (t) => {
  const root = apiRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({ private: true, workspaces: ["packages/*", "libs/*"] }),
  );
  put(
    root,
    "packages/lib/package.json",
    JSON.stringify({ name: "lib", main: "index.js" }),
  );
  put(root, "packages/lib/index.js", "exports.version = 1;\n");
  put(
    root,
    "packages/app/package.json",
    JSON.stringify({
      name: "app",
      main: "dist/index.js",
      scripts: { build: "node build.cjs" },
      dependencies: { lib: "workspace:*" },
    }),
  );
  put(
    root,
    "packages/app/build.cjs",
    'require("lib"); require("node:fs").mkdirSync("dist", { recursive: true }); require("node:fs").writeFileSync("dist/index.js", "exports.built = true;");',
  );
  put(root, "packages/app/tsconfig.json", "{}");
  put(root, "packages/app/src/index.ts", "export {};\n");
  commit(root);
  execFileSync("git", ["tag", "base"], { cwd: root });
  mkdirSync(join(root, "libs"));
  execFileSync("git", ["mv", "packages/lib", "libs/lib"], { cwd: root });
  commit(root);
  mkdirSync(join(root, "packages/app/node_modules"));
  symlinkSync(
    "../../../libs/lib",
    join(root, "packages/app/node_modules/lib"),
    "dir",
  );
  const result = bin(root, "api-diff", ["base"]);
  assert.match(result.stdout, /^Runtime API: 1 packages, 1 entries unchanged/m);
});

test("api-diff orders a devDependency cycle by its runtime edge, keeps every other devDependency edge, and ignores a tracked fixture sharing a workspace package's name", (t) => {
  const root = apiRepo(t);
  put(root, ".gitignore", "node_modules\ndist\n");
  put(
    root,
    "package.json",
    JSON.stringify({ private: true, workspaces: ["packages/*"] }),
  );
  const packages = {
    "packages/a-lib": { name: "lib", devDependencies: { app: "workspace:*" } },
    "packages/b-app": {
      name: "app",
      dependencies: { lib: "workspace:*" },
      devDependencies: { tool: "workspace:*" },
    },
    "packages/c-tool": { name: "tool" },
  };
  for (const [directory, manifest] of Object.entries(packages)) {
    put(
      root,
      `${directory}/package.json`,
      JSON.stringify({
        ...manifest,
        main: "dist/index.js",
        scripts: { build: "node build.cjs" },
      }),
    );
    put(root, `${directory}/tsconfig.json`, "{}");
    put(root, `${directory}/src/index.ts`, "export {};\n");
  }
  put(
    root,
    "test/fixtures/lib/package.json",
    JSON.stringify({ name: "lib", private: true, main: "index.js" }),
  );
  put(root, "test/fixtures/lib/index.js", "exports.version = 99;\n");
  const revision = (version: number) => {
    put(
      root,
      "packages/a-lib/build.cjs",
      `require("node:fs").mkdirSync("dist", { recursive: true }); require("node:fs").writeFileSync("dist/index.js", "exports.version = ${version};");`,
    );
    put(
      root,
      "packages/c-tool/build.cjs",
      'require("node:fs").mkdirSync("dist", { recursive: true }); require("node:fs").writeFileSync("dist/index.js", "exports.ok = true;");',
    );
    put(
      root,
      "packages/b-app/build.cjs",
      `require("tool"); const { version } = require("lib"); if (version !== ${version}) throw new Error("built against lib " + version); require("node:fs").mkdirSync("dist", { recursive: true }); require("node:fs").writeFileSync("dist/index.js", "exports.v" + version + " = true;");`,
    );
    commit(root);
  };
  revision(1);
  execFileSync("git", ["tag", "base"], { cwd: root });
  revision(2);
  execFileSync(process.execPath, ["build.cjs"], {
    cwd: join(root, "packages/a-lib"),
  });
  for (const [from, name, to] of [
    ["b-app", "lib", "a-lib"],
    ["a-lib", "app", "b-app"],
    ["b-app", "tool", "c-tool"],
  ]) {
    mkdirSync(join(root, `packages/${from}/node_modules`), { recursive: true });
    symlinkSync(
      `../../${to}`,
      join(root, `packages/${from}/node_modules/${name}`),
      "dir",
    );
  }
  const result = bin(root, "api-diff", ["base"]);
  assert.doesNotMatch(result.stdout, /Execution error: packages\/b-app: /);
  assert.match(result.stdout, /^-.*"key": "v1"/m);
  assert.match(result.stdout, /^\+.*"key": "v2"/m);
});

test("api-diff builds a package depending on the root package against the revision's own root", (t) => {
  const root = apiRepo(t);
  put(root, ".gitignore", "node_modules\ndist\n");
  const manifest = (name: string, extra: Manifest) =>
    JSON.stringify({
      name,
      main: "dist/index.js",
      scripts: { build: "node build.cjs" },
      ...extra,
    });
  put(root, "package.json", manifest("core", { workspaces: ["packages/*"] }));
  put(root, "tsconfig.json", "{}");
  put(
    root,
    "packages/plugin/package.json",
    manifest("plugin", { dependencies: { core: "workspace:*" } }),
  );
  put(root, "packages/plugin/tsconfig.json", "{}");
  put(root, "packages/plugin/src/index.ts", "export {};\n");
  const revision = (version: number) => {
    put(
      root,
      "build.cjs",
      `require("node:fs").mkdirSync("dist", { recursive: true }); require("node:fs").writeFileSync("dist/index.js", "exports.version = ${version};");`,
    );
    put(
      root,
      "packages/plugin/build.cjs",
      `const { version } = require("core"); if (version !== ${version}) throw new Error("built against core " + version); require("node:fs").mkdirSync("dist", { recursive: true }); require("node:fs").writeFileSync("dist/index.js", "exports.v" + version + " = true;");`,
    );
    commit(root);
  };
  revision(1);
  execFileSync("git", ["tag", "base"], { cwd: root });
  revision(2);
  execFileSync(process.execPath, ["build.cjs"], { cwd: root });
  mkdirSync(join(root, "packages/plugin/node_modules"));
  symlinkSync(
    "../../..",
    join(root, "packages/plugin/node_modules/core"),
    "dir",
  );
  const result = bin(root, "api-diff", ["base"]);
  assert.doesNotMatch(result.stdout, /Execution error: packages\/plugin: /);
  assert.match(result.stdout, /^-.*"key": "v1"/m);
});
