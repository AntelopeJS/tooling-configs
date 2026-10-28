import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  bundleDeclarations,
  WORKER_NODE_ARGS,
  workerCount,
} from "./declaration-bundle.ts";

const GIB = 1024 ** 3;

test("workerCount needs enough entries per worker and stays inside the cpus, the cap and the free memory", () => {
  assert.deepEqual(
    [
      workerCount(15, 32, 64 * GIB),
      workerCount(100, 32, 64 * GIB),
      workerCount(1000, 32, 64 * GIB),
      workerCount(1000, 3, 64 * GIB),
      workerCount(1000, 32, 4 * GIB),
      workerCount(1000, 32, GIB),
    ],
    [1, 6, 8, 3, 2, 1],
  );
});

test("a worker started with the worker options cannot grow its heap past the per-worker memory workerCount budgets for", () => {
  const run = spawnSync(
    process.execPath,
    [
      ...WORKER_NODE_ARGS,
      "-e",
      "process.stdout.write(String(require('node:v8').getHeapStatistics().heap_size_limit))",
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.ok(Number(run.stdout) <= 1.5 * GIB, run.stdout);
});

test("bundleDeclarations returns each entry's bundle at its own index whether one process or several produce them", (t) => {
  const root = mkdtempSync(join(tmpdir(), "antelope-bundle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const names = ["alpha", "beta", "gamma", "delta", "epsilon"];
  for (const name of names)
    writeFileSync(
      join(root, `${name}.d.ts`),
      `export interface ${name[0].toUpperCase()}${name.slice(1)} { ${name}: string }\n`,
    );
  const config = join(root, "tsconfig.json");
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: { types: [] },
      files: names.map((name) => `${name}.d.ts`),
    }),
  );
  const entries = names.map((name) => ({
    filePath: join(root, `${name}.d.ts`),
    output: { exportReferencedTypes: false, noBanner: true },
    libraries: { inlinedLibraries: [] },
  }));
  const compiler = dirname(
    createRequire(import.meta.url).resolve("typescript/package.json"),
  );
  const options = { preferredConfigPath: config };
  const sequential = bundleDeclarations(
    compiler,
    join(root, "one"),
    entries,
    options,
    1,
  );
  const parallel = bundleDeclarations(
    compiler,
    join(root, "many"),
    entries,
    options,
    3,
  );
  assert.equal(sequential.length, names.length);
  assert.match(sequential[3], /interface Delta/);
  assert.deepEqual(parallel, sequential);
});
