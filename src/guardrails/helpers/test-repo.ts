import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ANTELOPE_STYLE } from "../../oxc/fmt.ts";
import { CHECKS_SKIP_ENV } from "../checks.ts";

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

export function testRepo(t: TestContext, checksWorkflow = true): string {
  const root = mkdtempSync(join(tmpdir(), "antelope-guardrails-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  put(root, ".gitignore", "node_modules\n");
  if (checksWorkflow)
    put(
      root,
      ".github/workflows/ci.yml",
      "jobs:\n  checks:\n    steps:\n      - run: pnpm run checks\n",
    );
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

/** An `oxlint.config.ts` on the shared preset, with its plugin specifiers redirected to the unbuilt source, so a directive in the repository is live exactly when the preset reports its rule. */
export function usePreset(root: string, typeAware = false): void {
  const source = (path: string) =>
    JSON.stringify(join(PACKAGE_ROOT, "src/oxc", path));
  const lintModule = JSON.stringify(
    pathToFileURL(join(PACKAGE_ROOT, "src/oxc/lint.ts")).href,
  );
  put(
    root,
    "oxlint.config.ts",
    [
      `import { antelopePreset } from ${lintModule};`,
      "const preset = antelopePreset();",
      "for (const layer of preset.extends)",
      "  if (layer.jsPlugins)",
      "    layer.jsPlugins = layer.jsPlugins.map((plugin) => ({",
      "      ...plugin,",
      `      specifier: plugin.name === "anti-slop" ? ${source("anti-slop/index.ts")} : ${source("guardrails/index.ts")},`,
      "    }));",
      `export default { extends: [preset], options: { typeAware: ${typeAware} } };`,
      "",
    ].join("\n"),
  );
}

/** Runs a bin from source as CI would, without the caller's pull request base or checks skip, plus `env`, where an `undefined` value unsets the inherited variable. */
export function bin(
  root: string,
  name: string,
  args: string[] = [],
  env: Record<string, string | undefined> = {},
) {
  const {
    GITHUB_BASE_REF: _base,
    [CHECKS_SKIP_ENV]: _skip,
    ...inherited
  } = process.env;
  return spawnSync(
    process.execPath,
    [join(PACKAGE_ROOT, "src/bin", `${name}.ts`), ...args],
    { cwd: root, encoding: "utf8", env: { ...inherited, CI: "1", ...env } },
  );
}

export function read(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

export const API_BUILD_SCRIPT =
  "tsc --noEmit false --composite false --declarationMap false";

/** Makes `root`, an `apiRepo`, a repository whose `typescript`, and the `tsc` its build script runs, are the pack's `alias`: `typescript5`, TypeScript 5.9, or `@typescript/native`, TypeScript 7 without a compiler API. Every other package is the pack's own; without this call an `apiRepo` installs TypeScript 6's API as `typescript` beside TypeScript 7's `tsc`. */
export function onTypeScript(
  root: string,
  alias: "typescript5" | "@typescript/native",
): void {
  const modules = join(root, "node_modules");
  const pack = join(PACKAGE_ROOT, "node_modules");
  rmSync(modules);
  mkdirSync(join(modules, ".bin"), { recursive: true });
  for (const entry of readdirSync(pack))
    if (entry !== ".bin" && entry !== "typescript")
      symlinkSync(join(pack, entry), join(modules, entry), "dir");
  for (const bin of readdirSync(join(pack, ".bin")))
    if (bin !== "tsc")
      symlinkSync(join(pack, ".bin", bin), join(modules, ".bin", bin));
  symlinkSync(join(pack, alias), join(modules, "typescript"), "dir");
  writeFileSync(
    join(modules, ".bin/tsc"),
    `#!/bin/sh\nexec node ${JSON.stringify(join(pack, alias, "bin/tsc"))} "$@"\n`,
    { mode: 0o755 },
  );
}

/** A repository publishing a compiled `src` through `dist` with a build script, for the proof commands. */
export function apiRepo(t: TestContext): string {
  const root = testRepo(t);
  symlinkSync(
    join(PACKAGE_ROOT, "node_modules"),
    join(root, "node_modules"),
    "dir",
  );
  put(
    root,
    "package.json",
    JSON.stringify({
      name: "public-api",
      type: "module",
      scripts: { build: API_BUILD_SCRIPT },
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      },
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
      exclude: ["src/**/*.test.ts"],
    }),
  );
  return root;
}

/** `oxfmt --check` with the house style over `files` of the fixture repository. */
export function formatCheck(root: string, files: string[]) {
  put(root, "house-style.json", JSON.stringify(ANTELOPE_STYLE));
  return spawnSync(
    process.execPath,
    [
      join(PACKAGE_ROOT, "node_modules/oxfmt/bin/oxfmt"),
      "--config",
      "house-style.json",
      "--check",
      ...files,
    ],
    { cwd: root, encoding: "utf8" },
  );
}
