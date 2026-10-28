import type { generateDtsBundle } from "dts-bundle-generator";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism, freemem } from "node:os";
import { basename, dirname, join } from "node:path";

import { DIRECTORY_LINK } from "./revisions.ts";

type Entries = Parameters<typeof generateDtsBundle>[0];
type Options = Parameters<typeof generateDtsBundle>[1];

const ENTRIES_PER_WORKER = 16;
const MAX_WORKERS = 8;
const MIB = 1024 ** 2;
const WORKER_MEMORY = 1.5 * 1024 * MIB;
const WORKER_NATIVE_MEMORY = 256 * MIB;

/** Node options that keep a worker inside `WORKER_MEMORY`: the old-space cap leaves room for the memory V8 holds outside the heap, so a worker's resident size stays under the budget that `workerCount` assumes. */
export const WORKER_NODE_ARGS = [
  `--max-old-space-size=${(WORKER_MEMORY - WORKER_NATIVE_MEMORY) / MIB}`,
];

const WORKER = `
const { readFileSync, writeFileSync } = require("node:fs");
const { createRequire } = require("node:module");
try {
  const job = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const generate = createRequire(job.loader)("dts-bundle-generator").generateDtsBundle;
  writeFileSync(job.result, JSON.stringify(generate(job.entries, job.options)));
} catch (error) {
  process.stderr.write(String(error instanceof Error ? error.message : error));
  process.exit(1);
}
`;

const DRIVER = `
const { spawn } = require("node:child_process");
const [flags, worker, ...jobs] = process.argv.slice(1);
let failed = false;
let pending = jobs.length;
for (const job of jobs) {
  spawn(process.execPath, [...JSON.parse(flags), worker, job], { stdio: ["ignore", "inherit", "inherit"] }).on("exit", (code) => {
    failed ||= code !== 0;
    pending -= 1;
    if (pending === 0) process.exit(failed ? 1 : 0);
  });
}
`;

/** Places a copy of `dts-bundle-generator` beside a `typescript` link to the package at `compilerRoot`, the compiler the target repository builds with. The generator requires `typescript` by name, so this makes it drive that compiler instead of the one it was installed with. Returns a path to require the copy from. */
function installGenerator(compilerRoot: string, scratch: string): string {
  const source = dirname(
    createRequire(import.meta.url).resolve("dts-bundle-generator/package.json"),
  );
  const modules = join(scratch, "generator", "node_modules");
  mkdirSync(modules, { recursive: true });
  cpSync(source, join(modules, "dts-bundle-generator"), {
    recursive: true,
    filter: (path) => basename(path) !== "node_modules",
  });
  symlinkSync(compilerRoot, join(modules, "typescript"), DIRECTORY_LINK);
  return join(modules, "index.js");
}

/** Workers for `count` entries: each builds its own program, so a worker needs enough entries to repay that, and the bound keeps their combined heap inside the memory that is free. */
export function workerCount(
  count: number,
  cpus = availableParallelism(),
  free = freemem(),
): number {
  return Math.max(
    1,
    Math.min(
      Math.floor(count / ENTRIES_PER_WORKER),
      cpus,
      MAX_WORKERS,
      Math.floor(free / WORKER_MEMORY),
    ),
  );
}

function generateInWorkers(
  loader: string,
  directory: string,
  entries: Entries,
  options: Options,
  workers: number,
): string[] {
  const jobs = Array.from({ length: workers }, (_, worker) => ({
    indices: entries.flatMap((_entry, index) =>
      index % workers === worker ? [index] : [],
    ),
    file: join(directory, `job-${worker}.json`),
    result: join(directory, `result-${worker}.json`),
  }));
  for (const { indices, file, result } of jobs)
    writeFileSync(
      file,
      JSON.stringify({
        loader,
        result,
        options,
        entries: indices.map((index) => entries[index]),
      }),
    );
  const worker = join(directory, "worker.cjs");
  writeFileSync(worker, WORKER);
  const run = spawnSync(
    process.execPath,
    [
      "-e",
      DRIVER,
      JSON.stringify(WORKER_NODE_ARGS),
      worker,
      ...jobs.map(({ file }) => file),
    ],
    { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] },
  );
  if (run.error) throw run.error;
  if (run.status !== 0)
    throw new Error(run.stderr || "A declaration bundling worker failed.");
  const bundles: string[] = [];
  for (const { indices, result } of jobs)
    /* SAFETY: the worker wrote the generator's string array to this file. */
    for (const [position, bundle] of (
      JSON.parse(readFileSync(result, "utf8")) as string[]
    ).entries())
      bundles[indices[position]] = bundle;
  return bundles;
}

/** Bundles every entry's declarations with the compiler at `compilerRoot`. Large packages are split across worker processes by entry; each bundle depends only on its own entry, so the output is the same as one sequential call. */
export function bundleDeclarations(
  compilerRoot: string,
  scratch: string,
  entries: Entries,
  options: Options,
  workers = workerCount(entries.length),
): string[] {
  const loader = installGenerator(compilerRoot, scratch);
  if (workers > 1)
    return generateInWorkers(
      loader,
      join(scratch, "generator"),
      entries,
      options,
      workers,
    );
  /* SAFETY: the copy is the generator's own package, so its entry exports generateDtsBundle. */
  const generate = createRequire(loader)("dts-bundle-generator")
    .generateDtsBundle as typeof generateDtsBundle;
  return generate(entries, options);
}
