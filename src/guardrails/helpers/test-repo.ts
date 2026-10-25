import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = fileURLToPath(
  new URL("../../../", import.meta.url),
);

export function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

export function commit(root: string): void {
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Guardrails test",
      "-c",
      "user.email=guardrails@example.invalid",
      "commit",
      "-qm",
      "Fixture",
    ],
    { cwd: root },
  );
}

export function testRepo(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "antelope-guardrails-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  put(root, ".gitignore", "node_modules\n");
  put(
    root,
    "package.json",
    '{\n  "name": "guardrails-test",\n  "type": "module",\n  "packageManager": "npm@11.0.0"\n}\n',
  );
  commit(root);
  return root;
}

export function linkOxlint(root: string): void {
  const require = createRequire(import.meta.url);
  mkdirSync(join(root, "node_modules"), { recursive: true });
  symlinkSync(
    dirname(require.resolve("oxlint/package.json")),
    join(root, "node_modules/oxlint"),
    "dir",
  );
}

export function bin(root: string, name: string, args: string[] = []) {
  return spawnSync(
    process.execPath,
    [join(PACKAGE_ROOT, "src/bin", `${name}.ts`), ...args],
    { cwd: root, encoding: "utf8", env: { ...process.env, CI: "1" } },
  );
}

export function read(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}
