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
  return { status: result.status, output: result.stdout + result.stderr };
}

test("a project on TypeScript 6 keeps tsc at 6 after installing the packed pack, and antelopejs-tsc runs TypeScript 7, under each package manager; fails when TypeScript 7 is aliased under a name npm links before typescript, when a pack bin is named tsc, or when antelopejs-tsc runs the project's typescript", async (t) => {
  const { tarball } = await packedPack(t);
  for (const [manager, install] of Object.entries(INSTALLS))
    await t.test(manager, () => {
      const project = join(dirname(tarball), manager);
      mkdirSync(project);
      writeFileSync(
        join(project, "package.json"),
        JSON.stringify({
          name: `typescript7-${manager}`,
          private: true,
          devDependencies: {
            typescript: toolingVersions().typescript,
            "@antelopejs/tooling-configs": `file:${tarball}`,
          },
        }),
      );
      const installed = run(project, manager, install);
      assert.equal(installed.status, 0, installed.output);
      const tsc = run(project, "npx", ["--no-install", "tsc", "--version"]);
      assert.match(tsc.output, /^Version 6\./, tsc.output);
      const native = run(project, "npx", [
        "--no-install",
        "antelopejs-tsc",
        "--version",
      ]);
      assert.match(native.output, /^Version 7\.0\./, native.output);
    });
});
