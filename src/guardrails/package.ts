import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Manifest {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  workspaces?: unknown;
  antelopeJs?: { kind?: string; implements?: string[] };
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
        const tsgolint = manifest.devDependencies?.["oxlint-tsgolint"];
        if (!lefthook || !knip || !tsgolint)
          throw new Error(
            "tooling-configs must declare lefthook, knip and oxlint-tsgolint devDependencies.",
          );
        return { lefthook, knip, tsgolint };
      }
    }
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error("Cannot find tooling-configs package.json.");
    directory = parent;
  }
}

export function repositoryTools(manifest: Manifest) {
  const targets = {
    installed: {
      commands: {
        checks: "antelopejs-checks",
        size: "antelopejs-check-size",
        ratchet: "antelopejs-ratchet",
        suppressions: "antelopejs-suppressions",
        sync: "antelopejs-sync",
      },
      presets: {
        "oxlint.config.ts": "@antelopejs/tooling-configs/oxc/lint",
        "oxfmt.config.ts": "@antelopejs/tooling-configs/oxc/fmt",
        "knip.config.ts": "@antelopejs/tooling-configs/knip",
      },
      hookPrefix: `${execCommand(packageManager(manifest))} `,
    },
    source: {
      commands: {
        checks: "node src/bin/checks.ts",
        size: "node src/bin/check-size.ts",
        ratchet: "node src/bin/ratchet.ts",
        suppressions: "node src/bin/suppressions.ts",
        sync: "node src/bin/sync.ts",
      },
      presets: {
        "oxlint.config.ts": "./src/oxc/lint.ts",
        "oxfmt.config.ts": "./src/oxc/fmt.ts",
        "knip.config.ts": "./src/knip.ts",
      },
      hookPrefix: "",
    },
  };
  return targets[
    manifest.name === "@antelopejs/tooling-configs" ? "source" : "installed"
  ];
}

export const PREPARE_INSTALL =
  "if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && command -v lefthook >/dev/null 2>&1; then lefthook install; fi";

const DEFAULT_SCRIPTS = {
  typecheck: "tsc --noEmit",
  lint: "oxlint",
  format: "oxfmt .",
  "format:check": "oxfmt --check .",
  knip: "knip",
};

function prepareScript(current = ""): string {
  if (current.includes(PREPARE_INSTALL)) return current;
  const legacy =
    /(^|&&\s*|;\s*)(?:(?:pnpm exec|npm exec --|yarn exec|bun x --no-install)\s+)?lefthook\s+install(?=\s*(?:$|&&|;))/;
  if (legacy.test(current))
    return current.replace(legacy, `$1${PREPARE_INSTALL}`);
  return current ? `${current} && ${PREPARE_INSTALL}` : PREPARE_INSTALL;
}

export function managedPackage(
  current: string | undefined,
  versions: ReturnType<typeof toolingVersions>,
  options: { typeAware?: boolean; nuxt?: boolean; ratchet?: boolean } = {},
): string {
  if (current === undefined) throw new Error("package.json is missing.");
  const manifest = parseManifest(current);
  const scripts = (manifest.scripts ??= {});
  scripts.prepare = prepareScript(scripts.prepare);
  const tools = repositoryTools(manifest);
  Object.assign(scripts, tools.commands, {
    "ratchet:update": `${tools.commands.ratchet} --update`,
    "suppressions:update": `${tools.commands.suppressions} --update`,
    "sync:check": `${tools.commands.sync} --check`,
  });
  if (options.ratchet === false) {
    delete scripts.ratchet;
    delete scripts["ratchet:update"];
  }
  for (const [name, command] of Object.entries(DEFAULT_SCRIPTS))
    scripts[name] ??=
      name === "typecheck" && options.nuxt ? "nuxi typecheck" : command;
  const dependencies = (manifest.devDependencies ??= {});
  dependencies.lefthook ??= versions.lefthook;
  dependencies.knip ??= versions.knip;
  if (options.typeAware) dependencies["oxlint-tsgolint"] ??= versions.tsgolint;
  manifest.devDependencies = Object.fromEntries(
    Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)),
  );
  const indent = /^([\t ]+)"/m.exec(current)?.[1] ?? "  ";
  const newline = current.includes("\r\n") ? "\r\n" : "\n";
  return `${JSON.stringify(manifest, null, indent).replaceAll("\n", newline)}${newline}`;
}
