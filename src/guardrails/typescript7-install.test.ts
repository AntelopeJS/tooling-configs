import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { packedPack } from "./helpers/packed-pack.ts";
import { toolingVersions, type PackageManager } from "./package.ts";

const INSTALLS: Record<PackageManager, string[]> = {
  npm: ["install", "--no-audit", "--no-fund"],
  pnpm: ["install"],
  yarn: ["install", "--non-interactive"],
  bun: ["install"],
};

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

/** Writes a package at `directory` that declares TypeScript at `--init`'s range and the pack from `tarball`. */
function consumer(directory: string, tarball: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: `typescript7-${directory.split(/[\\/]/u).at(-1)}`,
      private: true,
      devDependencies: {
        typescript: toolingVersions().typescript,
        "@antelopejs/tooling-configs": `file:${tarball}`,
      },
    }),
  );
}

function assertCompilers(directory: string): void {
  const tsc = run(directory, "npx", ["--no-install", "tsc", "--version"]);
  assert.match(tsc.output, /^Version 6\./, tsc.output);
  const native = run(directory, "npx", [
    "--no-install",
    "antelopejs-tsc",
    "--version",
  ]);
  assert.match(native.output, /^Version 7\.0\./, native.output);
}

test("a project on TypeScript 6 keeps tsc at 6 after installing the packed pack, and antelopejs-tsc runs TypeScript 7, under each package manager and in an npm workspace, where npm links one tsc for the whole tree; fails when TypeScript 7's alias sorts before every TypeScript 6 package that ships a tsc, when a pack bin is named tsc, or when antelopejs-tsc runs the project's typescript", async (t) => {
  const { tarball } = await packedPack(t);
  const scratch = dirname(tarball);
  for (const [manager, install] of Object.entries(INSTALLS))
    await t.test(manager, () => {
      const project = join(scratch, manager);
      consumer(project, tarball);
      const installed = run(project, manager, install);
      assert.equal(installed.status, 0, installed.output);
      assertCompilers(project);
    });
  await t.test("npm workspace", () => {
    const root = join(scratch, "workspace");
    mkdirSync(root);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ private: true, workspaces: ["member"] }),
    );
    consumer(join(root, "member"), tarball);
    const installed = run(root, "npm", INSTALLS.npm);
    assert.equal(installed.status, 0, installed.output);
    assertCompilers(join(root, "member"));
  });
});
