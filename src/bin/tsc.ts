#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const platformPackage = `@typescript/typescript-${process.platform}-${process.arch}`;
let manifest: string;
try {
  manifest = fileURLToPath(
    import.meta.resolve(`${platformPackage}/package.json`),
  );
} catch {
  process.stderr.write(
    `antelopejs-tsc: ${platformPackage}, TypeScript 7 for this platform, is not installed. Install the pack's optional dependencies, or run tsc.\n`,
  );
  process.exit(1);
}
const exe = join(
  dirname(manifest),
  "lib",
  process.platform === "win32" ? "tsc.exe" : "tsc",
);
const args = process.argv.slice(2);
if (process.platform !== "win32" && process.execve !== undefined)
  process.execve(exe, [exe, ...args]);
const result = spawnSync(exe, args, { stdio: "inherit" });
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
process.exitCode = result.status ?? 1;
