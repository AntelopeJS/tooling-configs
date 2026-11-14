import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import packManifest from "../../package.json" with { type: "json" };
import { admits } from "../garden/semver.ts";

/** A `package.json` `exports` value: a path, `null` to hide a subpath, a list of fallbacks, or a map of subpaths or conditions. */
export type ExportTarget =
  | string
  | null
  | ExportTarget[]
  | { [key: string]: ExportTarget };

export interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
  type?: string;
  types?: string;
  typings?: string;
  exports?: ExportTarget;
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

/** The capture tool's optional peers, which a repository with `docs/captures.ts` declares as devDependencies at the ranges the pack tests against. */
const CAPTURE_PEERS = [
  "mongodb-memory-server",
  "pixelmatch",
  "playwright-core",
  "sharp",
] as const;

type CapturePeer = (typeof CAPTURE_PEERS)[number];

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

/** Whether the repository at `root` is a Nuxt app: it depends on `nuxt` or has a `nuxt.config.*`. */
export function usesNuxt(root: string, manifest: Manifest): boolean {
  return Boolean(
    manifest.dependencies?.nuxt ||
    manifest.devDependencies?.nuxt ||
    readdirSync(root).some((name) => name.startsWith("nuxt.config.")),
  );
}

/** Whether the repository at `root` has `docs/captures.ts`, so it declares the capture tool's peers. */
export function usesCaptures(root: string): boolean {
  return existsSync(join(root, "docs/captures.ts"));
}

export function execCommand(manager: PackageManager): string {
  if (manager === "npm") return "npm exec --";
  if (manager === "bun") return "bun x --no-install";
  return `${manager} exec`;
}

/** The directory of the installed `@antelopejs/tooling-configs` package, from source or from `dist`. */
export function toolingRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const path = join(directory, "package.json");
    if (
      existsSync(path) &&
      parseManifest(readFileSync(path, "utf8")).name ===
        "@antelopejs/tooling-configs"
    )
      return directory;
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error("Cannot find tooling-configs package.json.");
    directory = parent;
  }
}

/** The range of `spec` when it is the npm alias `npm:<name>@<range>`. */
function aliasedRange(spec: string, name: string): string {
  const prefix = `npm:${name}@`;
  if (!spec.startsWith(prefix))
    throw new Error(
      `tooling-configs must declare @typescript/native as ${prefix}<range>.`,
    );
  return spec.slice(prefix.length);
}

export function toolingVersions() {
  const manifest = parseManifest(
    readFileSync(join(toolingRoot(), "package.json"), "utf8"),
  );
  const dev = (name: string): string => {
    const range = manifest.devDependencies?.[name];
    if (!range)
      throw new Error(
        `tooling-configs must declare ${name} in devDependencies.`,
      );
    return range;
  };
  if (!manifest.version)
    throw new Error("tooling-configs must declare its version.");
  return {
    lefthook: dev("lefthook"),
    knip: dev("knip"),
    tsgolint: dev("oxlint-tsgolint"),
    oxlint: dev("oxlint"),
    oxfmt: dev("oxfmt"),
    typescript: aliasedRange(dev("@typescript/native"), "typescript"),
    nodeTypes: dev("@types/node"),
    capture: CAPTURE_PEERS.map((name): [CapturePeer, string] => [
      name,
      dev(name),
    ]),
    packageManager: packManifest.packageManager,
    pack: manifest.version,
  };
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

function defaultScripts(nuxt: boolean | undefined) {
  return { ...DEFAULT_SCRIPTS, ...(nuxt && { typecheck: "nuxi typecheck" }) };
}

function sortedEntries(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
  );
}

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

interface DependencyOptions {
  typeAware?: boolean;
  /** Whether `docs/captures.ts` exists, so the capture tool's peers are declared. */
  captures?: boolean;
}

/** Whether `range`'s lowest named version is one the pack's `tested` range admits. A `workspace:` or `catalog:` spec resolves elsewhere and is kept as declared. */
function withinTested(range: string | undefined, tested: string): boolean {
  if (range?.startsWith("workspace:") || range?.startsWith("catalog:"))
    return true;
  const floor = /\d+\.\d+\.\d+/.exec(range ?? "")?.[0];
  return floor !== undefined && admits(tested, floor);
}

/** The devDependencies, with their ranges, that sync writes into `manifest`: tools it lacks, and capture peers it lacks or declares below the pack's tested range. */
export function addedDevDependencies(
  manifest: Manifest,
  versions: ReturnType<typeof toolingVersions>,
  options: DependencyOptions,
): [string, string][] {
  const declared = manifest.devDependencies ?? {};
  const tools: [string, string][] = [
    ["lefthook", versions.lefthook],
    ["knip", versions.knip],
  ];
  if (options.typeAware) tools.push(["oxlint-tsgolint", versions.tsgolint]);
  return [
    ...tools.filter(([name]) => !declared[name]),
    ...(options.captures
      ? versions.capture.filter(
          ([name, tested]) => !withinTested(declared[name], tested),
        )
      : []),
  ];
}

/**
 * The pack, oxlint, oxlint-tsgolint, oxfmt and typescript with the ranges `--init` declares for a repository that has
 * none of them, and `@types/node` when `nodeProject` says init writes the tsconfig that loads it. Sync needs the first
 * three installed to load its preset and run the type-aware baseline before it writes any devDependency; the synced
 * `typecheck` script runs typescript's `tsc`.
 */
export function bootstrapDependencies(
  manifest: Manifest,
  versions: ReturnType<typeof toolingVersions>,
  nodeProject: boolean,
): [string, string][] {
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  const wanted: [string, string][] = [
    ["@antelopejs/tooling-configs", `^${versions.pack}`],
    ["oxlint", versions.oxlint],
    ["oxlint-tsgolint", versions.tsgolint],
    ["oxfmt", versions.oxfmt],
    ["typescript", versions.typescript],
  ];
  if (nodeProject) wanted.push(["@types/node", versions.nodeTypes]);
  return wanted.filter(([name]) => !declared[name]);
}

/** The `test` script `npm init` writes, which fails every run. */
const NPM_INIT_TEST = 'echo "Error: no test specified" && exit 1';

/**
 * `current` with `added` in its sorted devDependencies, `packageManager` set to `pin` unless it names pnpm, the only
 * manager the pack's CI installs with, and a `test` script running Node's test runner when it has none or only npm's
 * failing default, which passes with no test file and runs the ones the repository adds. An explicit `"type": "commonjs"`, which `npm init` writes, is dropped: under
 * it Node refuses to load the pack's ESM `*.config.ts` files, while without it `.js` files stay CommonJS unless they
 * use ESM syntax, which `commonjs` rejected anyway. Formatted as the rest of the sync writers do.
 */
export function bootstrappedManifest(
  current: string,
  added: readonly [string, string][],
  pin: string,
): string {
  const manifest = parseManifest(current);
  manifest.devDependencies = sortedEntries({
    ...manifest.devDependencies,
    ...Object.fromEntries(added),
  });
  if (
    manifest.packageManager === undefined ||
    packageManager(manifest) !== "pnpm"
  )
    manifest.packageManager = pin;
  if (manifest.type === "commonjs") delete manifest.type;
  const scripts = (manifest.scripts ??= {});
  if (scripts.test === undefined || scripts.test === NPM_INIT_TEST)
    scripts.test = "node --test";
  return serializeManifest(manifest, current);
}

export function managedPackage(
  current: string | undefined,
  versions: ReturnType<typeof toolingVersions>,
  options: DependencyOptions & { nuxt?: boolean; ratchet?: boolean } = {},
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
  for (const [name, command] of Object.entries(defaultScripts(options.nuxt)))
    scripts[name] ??= command;
  manifest.devDependencies = sortedEntries({
    ...manifest.devDependencies,
    ...Object.fromEntries(addedDevDependencies(manifest, versions, options)),
  });
  return serializeManifest(manifest, current);
}

/**
 * The template profile owns the scripts and devDependencies `antelopejs-checks`
 * runs, without the hooks: the pack's commands are set, and the other steps get
 * a default only where the template has none, so its own `test`, `lint` or
 * `sync` stays. An already complete manifest is returned unchanged, so a
 * template is never reformatted for nothing.
 */
export function templatePackage(
  current: string | undefined,
  versions: ReturnType<typeof toolingVersions>,
  options: { ratchet: boolean; nuxt?: boolean; typeAware?: boolean },
): string {
  if (current === undefined) throw new Error("package.json is missing.");
  const manifest = parseManifest(current);
  const { commands } = repositoryTools(manifest);
  const sync = `${commands.sync} --profile template`;
  const scripts = (manifest.scripts ??= {});
  const dependencies = (manifest.devDependencies ??= {});
  const set = Object.entries({
    checks: commands.checks,
    size: commands.size,
    suppressions: commands.suppressions,
    "suppressions:update": `${commands.suppressions} --update`,
    ...(options.ratchet && {
      ratchet: commands.ratchet,
      "ratchet:update": `${commands.ratchet} --update`,
    }),
  }).filter(([name, command]) => scripts[name] !== command);
  const defaults = Object.entries({
    ...defaultScripts(options.nuxt),
    sync,
    "sync:check": `${sync} --check`,
  }).filter(([name]) => scripts[name] === undefined);
  const missing = Object.entries({
    knip: versions.knip,
    ...(options.typeAware && { "oxlint-tsgolint": versions.tsgolint }),
  }).filter(([name]) => dependencies[name] === undefined);
  if (set.length + defaults.length + missing.length === 0) return current;
  Object.assign(scripts, Object.fromEntries([...defaults, ...set]));
  manifest.devDependencies = sortedEntries({
    ...dependencies,
    ...Object.fromEntries(missing),
  });
  return serializeManifest(manifest, current);
}

/** `manifest` as JSON in the indentation and line endings of `current`, the text it was read from. */
export function serializeManifest(manifest: Manifest, current: string): string {
  const indent = /^([\t ]+)"/m.exec(current)?.[1] ?? "  ";
  const newline = current.includes("\r\n") ? "\r\n" : "\n";
  return `${JSON.stringify(manifest, null, indent).replaceAll("\n", newline)}${newline}`;
}
