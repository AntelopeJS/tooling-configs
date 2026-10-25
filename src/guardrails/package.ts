import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Manifest {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

export function parseManifest(text: string): Manifest {
  /* SAFETY: package.json is written by package managers; every Manifest field is optional and read with a fallback. */
  const manifest = JSON.parse(text) as Manifest | null;
  if (manifest === null || Array.isArray(manifest))
    throw new Error("package.json must contain an object.");
  return manifest;
}

export function packageManager(manifest: Manifest): PackageManager {
  const manager = (manifest.packageManager ?? "pnpm").split("@")[0];
  switch (manager) {
    case "pnpm":
    case "npm":
    case "yarn":
    case "bun":
      return manager;
    default:
      throw new Error(
        `Unsupported package manager ${manager}. Expected pnpm, npm, yarn, or bun.`,
      );
  }
}

export function execCommand(manager: PackageManager): string {
  if (manager === "npm") return "npm exec --";
  if (manager === "bun") return "bun x --no-install";
  return `${manager} exec`;
}

export function toolingVersions() {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const path = join(directory, "package.json");
    if (existsSync(path)) {
      const manifest = parseManifest(readFileSync(path, "utf8"));
      if (manifest.name === "@antelopejs/tooling-configs") {
        const lefthook = manifest.devDependencies?.lefthook;
        const knip = manifest.devDependencies?.knip;
        if (!lefthook || !knip)
          throw new Error(
            "tooling-configs must declare lefthook and knip devDependencies.",
          );
        return { lefthook, knip };
      }
    }
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error("Cannot find tooling-configs package.json.");
    directory = parent;
  }
}

const MANAGED_SCRIPTS = {
  checks: "antelopejs-checks",
  size: "antelopejs-check-size",
  ratchet: "antelopejs-ratchet",
  "ratchet:update": "antelopejs-ratchet --update",
  sync: "antelopejs-sync",
  "sync:check": "antelopejs-sync --check",
};

const DEFAULT_SCRIPTS = {
  typecheck: "tsc --noEmit",
  lint: "oxlint",
  format: "oxfmt .",
  "format:check": "oxfmt --check .",
  knip: "knip",
};

export function managedPackage(
  current: string | undefined,
  versions: ReturnType<typeof toolingVersions>,
): string {
  if (current === undefined) throw new Error("package.json is missing.");
  const manifest = parseManifest(current);
  const scripts = (manifest.scripts ??= {});
  const install = `${execCommand(packageManager(manifest))} lefthook install`;
  if (!/(?:^|\s)lefthook\s+install(?:\s|$)/.test(scripts.prepare ?? ""))
    scripts.prepare = scripts.prepare
      ? `${scripts.prepare} && ${install}`
      : install;
  Object.assign(scripts, MANAGED_SCRIPTS);
  for (const [name, command] of Object.entries(DEFAULT_SCRIPTS))
    scripts[name] ??= command;
  const dependencies = (manifest.devDependencies ??= {});
  dependencies.lefthook ??= versions.lefthook;
  dependencies.knip ??= versions.knip;
  manifest.devDependencies = Object.fromEntries(
    Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)),
  );
  const indent = /^([\t ]+)"/m.exec(current)?.[1] ?? "  ";
  const newline = current.includes("\r\n") ? "\r\n" : "\n";
  return `${JSON.stringify(manifest, null, indent).replaceAll("\n", newline)}${newline}`;
}
