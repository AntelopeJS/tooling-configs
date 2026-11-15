import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { packedPack } from "./helpers/packed-pack.ts";
import type { PackageManager } from "./package.ts";

/** The TypeScript versions a project pins: the 5.9 line most repositories still run, and a 6.0 patch older than the newest. */
const PINS = ["5.9.3", "6.0.2"];

/** The install command of each manager; yarn gets a cache of its own, because yarn 1 serves a `file:` tarball it cached in an earlier run in place of the one under test. */
function installs(scratch: string): Record<PackageManager, string[]> {
  return {
    npm: ["install", "--no-audit", "--no-fund"],
    pnpm: ["install"],
    yarn: [
      "install",
      "--non-interactive",
      "--cache-folder",
      join(scratch, "yarn-cache"),
    ],
    bun: ["install"],
  };
}

function run(cwd: string, command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return {
    status: result.status,
    output: `${result.error?.message ?? ""}${result.stdout}${result.stderr}`,
  };
}

/** Writes a package at `directory` that pins `typescript` and declares the pack from `tarball`. */
function consumer(
  directory: string,
  tarball: string,
  typescript: string,
): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: `typescript-${directory.split(/[\\/]/u).at(-1)}`,
      private: true,
      devDependencies: {
        typescript: typescript,
        "@antelopejs/tooling-configs": `file:${tarball}`,
      },
    }),
  );
}

/** The command that runs a bin the project installs: `npx`, except for bun on Windows, whose `.exe` and `.bunx` shims npx does not find. */
function binRunner(manager: string): [string, ...string[]] {
  return manager === "bun" && process.platform === "win32"
    ? ["bun", "run"]
    : ["npx", "--no-install"];
}

/** The version of the `typescript` the installed pack's own modules import, from the nearest `node_modules` that holds the pack, as a workspace may hoist it. */
function packTypeScript(directory: string): string {
  return run(directory, process.execPath, [
    "--input-type=module",
    "-e",
    'import { createRequire } from "node:module"; import { existsSync, realpathSync } from "node:fs"; import { dirname, join } from "node:path"; let folder = process.cwd(); while (!existsSync(join(folder, "node_modules/@antelopejs/tooling-configs"))) folder = dirname(folder); const pack = realpathSync(join(folder, "node_modules/@antelopejs/tooling-configs/package.json")); process.stdout.write(createRequire(pack)("typescript/package.json").version);',
  ]).output;
}

function assertCompilers(
  directory: string,
  manager: string,
  typescript: string,
): void {
  const [runner, ...options] = binRunner(manager);
  const tsc = run(directory, runner, [...options, "tsc", "--version"]);
  assert.equal(tsc.output.trim(), `Version ${typescript}`, tsc.output);
  const native = run(directory, runner, [
    ...options,
    "antelopejs-tsc",
    "--version",
  ]);
  assert.match(native.output, /^Version 7\.0\./, native.output);
  assert.match(packTypeScript(directory), /^6\./);
}

test("a project keeps the tsc of the typescript it pins after installing the packed pack, antelopejs-tsc runs TypeScript 7 and the pack's modules import TypeScript 6, under each package manager and in an npm workspace; fails when the pack installs an aliased package that ships a tsc, which npm and bun link over the project's whatever names sort first", async (t) => {
  const { tarball } = await packedPack(t);
  const scratch = dirname(tarball);
  const commands = installs(scratch);
  for (const [manager, install] of Object.entries(commands))
    for (const typescript of PINS)
      await t.test(`${manager}, typescript ${typescript}`, () => {
        const project = join(scratch, `${manager}-${typescript}`);
        consumer(project, tarball, typescript);
        const installed = run(project, manager, install);
        assert.equal(installed.status, 0, installed.output);
        assertCompilers(project, manager, typescript);
      });
  await t.test("npm workspace, typescript 5.9.3", () => {
    const root = join(scratch, "workspace");
    mkdirSync(root);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ private: true, workspaces: ["member"] }),
    );
    consumer(join(root, "member"), tarball, "5.9.3");
    const installed = run(root, "npm", commands.npm);
    assert.equal(installed.status, 0, installed.output);
    assertCompilers(join(root, "member"), "npm", "5.9.3");
  });
});
