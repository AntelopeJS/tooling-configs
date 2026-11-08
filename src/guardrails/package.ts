import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
  packageManager?: string;
  bin?: { tsc?: string };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  workspaces?: unknown;
  engines?: { node?: string };
  antelopeJs?: {
    kind?: string;
    implements?: string[];
    docs?: { standard?: boolean };
  };
  /** Renovate's deprecated in-manifest config, read when no config file exists. */
  renovate?: unknown;
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
        if (!lefthook || !knip || !tsgolint || !manifest.version)
          throw new Error(
            "tooling-configs must declare its version and lefthook, knip and oxlint-tsgolint devDependencies.",
          );
        return { lefthook, knip, tsgolint, pack: manifest.version };
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

/** Installs hooks only in a folder whose own `.git` is a working repository, the top of a checkout, worktree or submodule. `GIT_DIR` and `GIT_WORK_TREE` are pinned to that folder, since a git hook or CI wrapper can point them at an outer repository, and a `.git` that does not resolve skips silently. */
export const PREPARE_INSTALL =
  "if [ -e .git ] && command -v git >/dev/null 2>&1 && command -v lefthook >/dev/null 2>&1 && GIT_DIR=.git GIT_WORK_TREE=. git rev-parse --git-dir >/dev/null 2>&1; then GIT_DIR=.git GIT_WORK_TREE=. lefthook install; fi";

const PREVIOUS_PREPARE_INSTALLS = [
  "if [ -e .git ] && command -v git >/dev/null 2>&1 && command -v lefthook >/dev/null 2>&1; then lefthook install; fi",
  "if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && command -v lefthook >/dev/null 2>&1; then lefthook install; fi",
  'if [ "$(git rev-parse --is-inside-work-tree --show-prefix 2>/dev/null)" = true ] && command -v lefthook >/dev/null 2>&1; then lefthook install; fi',
];

/** Every earlier install in one pass, so text a replacement inserts is never scanned again. */
const PREVIOUS_INSTALL = new RegExp(
  PREVIOUS_PREPARE_INSTALLS.map((script) =>
    script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ).join("|"),
  "g",
);

const DEFAULT_SCRIPTS = {
  typecheck: "tsc --noEmit",
  lint: "oxlint",
  format: "oxfmt .",
  "format:check": "oxfmt --check .",
  knip: "knip",
};

/** Stands in for the current install while the script is split on its separators, since the install holds `&&` itself. */
const INSTALL_TOKEN = "\u0000prepare-install\u0000";

/** Rewrites every earlier synced install to the current one in one pass and keeps a single install, whatever separator joined the copies. */
function migratePrepare(current: string): string {
  const tokenized = current
    .split(PREPARE_INSTALL)
    .map((part) => part.replace(PREVIOUS_INSTALL, () => INSTALL_TOKEN))
    .join(INSTALL_TOKEN);
  let seen = false;
  return tokenized
    .split(/(\s*(?:&&|\|\||;)\s*)/)
    .reduce<string[]>((kept, piece, index, pieces) => {
      if (index % 2 === 1) return kept;
      if (piece === INSTALL_TOKEN && seen) return kept;
      seen ||= piece === INSTALL_TOKEN;
      return kept.length === 0 ? [piece] : [...kept, pieces[index - 1], piece];
    }, [])
    .join("")
    .replaceAll(INSTALL_TOKEN, () => PREPARE_INSTALL);
}

function prepareScript(current = ""): string {
  const migrated = migratePrepare(current);
  if (migrated.includes(PREPARE_INSTALL)) return migrated;
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
  return serializeManifest(manifest, current);
}

/**
 * The template profile owns only the scripts `antelopejs-checks` requires and
 * the profile's `sync` scripts do not provide. An already complete manifest is
 * returned unchanged, so a template is never reformatted for nothing.
 */
export function templatePackage(
  current: string | undefined,
  options: { ratchet: boolean },
): string {
  if (current === undefined) throw new Error("package.json is missing.");
  const manifest = parseManifest(current);
  const commands = repositoryTools(manifest).commands;
  const wanted = {
    suppressions: commands.suppressions,
    "suppressions:update": `${commands.suppressions} --update`,
    ...(options.ratchet && {
      ratchet: commands.ratchet,
      "ratchet:update": `${commands.ratchet} --update`,
    }),
  };
  const scripts = (manifest.scripts ??= {});
  if (
    Object.entries(wanted).every(([name, command]) => scripts[name] === command)
  )
    return current;
  Object.assign(scripts, wanted);
  return serializeManifest(manifest, current);
}

function serializeManifest(manifest: Manifest, current: string): string {
  const indent = /^([\t ]+)"/m.exec(current)?.[1] ?? "  ";
  const newline = current.includes("\r\n") ? "\r\n" : "\n";
  return `${JSON.stringify(manifest, null, indent).replaceAll("\n", newline)}${newline}`;
}
