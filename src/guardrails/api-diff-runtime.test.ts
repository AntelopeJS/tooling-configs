import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { apiRepo, bin, commit, put } from "./helpers/test-repo.ts";

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
