import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { join, relative } from "node:path";
import { stringify } from "yaml";

import { workspaceDirectories } from "./docs-compat.ts";
import {
  type Manifest,
  type PackageManager,
  packageManager,
  parseManifest,
} from "./package.ts";
import {
  CONSUMER_FILES,
  CONSUMER_OPTIONS,
  entrySpecifiers,
} from "./published-entries.ts";
import { runCommand } from "./run-command.ts";

/** A package of the repository that publishes declarations: its directory relative to the root, `""` for the root, and its `name`. */
interface TypedPackage {
  directory: string;
  name: string;
}

/** A packed package: why packing failed, else the tarball and the manifest it holds. */
type Packed =
  | { failure: string }
  | { failure: ""; tarball: string; manifest: Manifest };

/** One run of the check: the packages of the repository a consumer could install, by name, and each one packed so far. */
interface Run {
  root: string;
  manager: "pnpm" | "npm";
  scratch: string;
  signal: AbortSignal | undefined;
  members: Map<string, string>;
  packs: Map<string, Packed>;
}

const DECLARATION_FILE = /\.d\.[cm]?ts$/;

/** An `exports` map that names declarations: a `types` condition or a `.d.ts`, `.d.mts` or `.d.cts` target. */
const TYPED_EXPORTS = /"types"\s*:|\.d\.[cm]?ts"/;

function declaresTypes(manifest: Manifest): boolean {
  return (
    manifest.types !== undefined ||
    manifest.typings !== undefined ||
    TYPED_EXPORTS.test(JSON.stringify(manifest.exports ?? null))
  );
}

/** The root and workspace packages that are not `private`, with their manifests. */
function publicPackages(root: string) {
  return ["", ...workspaceDirectories(root)].flatMap((directory) => {
    const manifest = parseManifest(
      readFileSync(join(root, directory, "package.json"), "utf8"),
    );
    const { name } = manifest;
    return name && manifest.private !== true
      ? [{ directory, name, manifest }]
      : [];
  });
}

/** The root and workspace packages that are not `private` and declare declarations through `types`, `typings` or `exports`. */
export function typedPackages(root: string): TypedPackage[] {
  return publicPackages(root)
    .filter(({ manifest }) => declaresTypes(manifest))
    .map(({ directory, name }) => ({ directory, name }));
}

/** The arguments that install a consumer's dependencies without a lockfile and without running install scripts. */
const INSTALL_ARGUMENTS: Record<"pnpm" | "npm", string[]> = {
  pnpm: [
    "install",
    "--ignore-scripts",
    "--prefer-offline",
    "--no-frozen-lockfile",
  ],
  npm: [
    "install",
    "--ignore-scripts",
    "--prefer-offline",
    "--no-audit",
    "--no-fund",
  ],
};

/** The files under `directory`, relative to it with `/` separators, its `node_modules` left out. */
function shippedFiles(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory())
      return entry.name === "node_modules"
        ? []
        : shippedFiles(join(directory, entry.name), `${path}/`);
    return entry.isFile() ? [path] : [];
  });
}

/** `output` with the consumer's own path and the package manager's store path before the package removed, so each error names the file as `<name>/<path>`. */
function readable(output: string, consumer: string, name: string): string {
  const store = new RegExp(
    String.raw`(?:node_modules/\.pnpm/[^/\s]+/)?node_modules/${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/`,
    "g",
  );
  return [consumer, consumer.replaceAll("\\", "/")]
    .reduce((text, path) => text.split(`${path}/`).join(""), output)
    .replace(store, `${name}/`);
}

const TAR_BLOCK = 512;

/** The text of the entry `path` in the gzipped tar archive `tarball`, read in Node so no `tar` binary, which differs across platforms, is needed. */
function tarEntry(tarball: string, path: string): string | undefined {
  const archive = gunzipSync(readFileSync(tarball));
  for (let offset = 0; offset + TAR_BLOCK <= archive.length;) {
    const header = archive.subarray(offset, offset + TAR_BLOCK);
    const name = header.toString("utf8", 0, 100).replace(/\0.*$/s, "");
    if (!name) return undefined;
    const size = Number.parseInt(header.toString("utf8", 124, 136), 8) || 0;
    const start = offset + TAR_BLOCK;
    if (name === path) return archive.toString("utf8", start, start + size);
    offset = start + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  return undefined;
}

function packedManifest(destination: string): Packed {
  const [file = ""] = readdirSync(destination);
  const tarball = join(destination, file);
  const text = tarEntry(tarball, "package/package.json");
  return text === undefined
    ? { failure: `${file} holds no package/package.json.\n` }
    : { failure: "", tarball, manifest: parseManifest(text) };
}

/** Packs the package `name` once per run, running its `prepack`, and reads the manifest its tarball holds. */
async function pack(run: Run, name: string): Promise<Packed> {
  const cached = run.packs.get(name);
  if (cached) return cached;
  const slot = String(run.packs.size);
  const destination = join(run.scratch, "tarballs", slot);
  mkdirSync(destination, { recursive: true });
  const result = await runCommand(
    run.manager,
    ["pack", "--pack-destination", destination],
    { cwd: join(run.root, run.members.get(name) ?? ""), signal: run.signal },
  );
  const packed: Packed =
    result.status === 0
      ? packedManifest(destination)
      : { failure: `Packing ${name} failed:\n${result.output}` };
  run.packs.set(name, packed);
  return packed;
}

function dependencyNames(manifest: Manifest): string[] {
  return [
    manifest.dependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ].flatMap((ranges) => Object.keys(ranges ?? {}));
}

/** The tarball of each package of the repository that `name`'s packed manifest depends on, directly or through another such package, by name. */
async function siblingTarballs(
  run: Run,
  name: string,
  manifest: Manifest,
): Promise<{ failure: string; tarballs: Map<string, string> }> {
  const tarballs = new Map<string, string>();
  const pending = [manifest];
  for (let next = pending.pop(); next; next = pending.pop())
    for (const dependency of dependencyNames(next)) {
      if (dependency === name || tarballs.has(dependency)) continue;
      if (!run.members.has(dependency)) continue;
      const sibling = await pack(run, dependency);
      if (!("tarball" in sibling))
        return { failure: sibling.failure, tarballs };
      tarballs.set(dependency, `file:${sibling.tarball}`);
      pending.push(sibling.manifest);
    }
  return { failure: "", tarballs };
}

/** Writes the consumer's `package.json`, and for pnpm its `pnpm-workspace.yaml` in block style, which pnpm edits when it records a setting, so each sibling resolves to its tarball wherever it is required. */
function writeConsumer(
  consumer: string,
  manager: "pnpm" | "npm",
  dependencies: Record<string, string>,
  overrides: Record<string, string>,
) {
  const manifest = {
    name: "published-types-consumer",
    private: true,
    dependencies,
  };
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify(
      manager === "npm"
        ? { ...manifest, overrides }
        : { ...manifest, pnpm: { overrides } },
    ),
  );
  if (manager === "pnpm")
    writeFileSync(
      join(consumer, "pnpm-workspace.yaml"),
      stringify({ packages: ["."], overrides }),
    );
}

async function typecheck(
  run: Run,
  consumer: string,
  typed: TypedPackage,
  manifest: Manifest,
) {
  const installed = realpathSync(join(consumer, "node_modules", typed.name));
  const files = shippedFiles(installed);
  const entries = entrySpecifiers(
    typed.name,
    manifest.exports,
    files,
    consumer,
  );
  const lines = {
    import: entries.import.map(
      (specifier, index) =>
        `import type * as entry${index} from ${JSON.stringify(specifier)};\n`,
    ),
    require: entries.require.map(
      (specifier, index) =>
        `import entry${index} = require(${JSON.stringify(specifier)});\n`,
    ),
  };
  const written = (["import", "require"] as const).flatMap((mode) => {
    if (!lines[mode].length) return [];
    const { file } = CONSUMER_FILES[mode];
    writeFileSync(join(consumer, file), lines[mode].join(""));
    return [file];
  });
  const deep =
    manifest.exports === undefined
      ? files
          .filter((file) => DECLARATION_FILE.test(file))
          .map((file) => relative(consumer, join(installed, file)))
      : [];
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: CONSUMER_OPTIONS,
      files: [...written, ...deep],
    }),
  );
  const typescript = join(consumer, "node_modules", "typescript");
  const { bin } = parseManifest(
    readFileSync(join(typescript, "package.json"), "utf8"),
  );
  const tsc = await runCommand(
    process.execPath,
    [join(typescript, bin?.tsc ?? "bin/tsc"), "-p", ".", "--pretty", "false"],
    { cwd: consumer, signal: run.signal, shell: false },
  );
  return tsc.status === 0 ? "" : readable(tsc.output, consumer, typed.name);
}

async function consumerErrors(run: Run, typed: TypedPackage, slot: number) {
  const packed = await pack(run, typed.name);
  if (!("tarball" in packed)) return packed.failure;
  const siblings = await siblingTarballs(run, typed.name, packed.manifest);
  if (siblings.failure) return siblings.failure;
  const consumer = join(run.scratch, `consumer-${slot}`);
  mkdirSync(consumer);
  const overrides = {
    ...Object.fromEntries(siblings.tarballs),
    [typed.name]: `file:${packed.tarball}`,
  };
  writeConsumer(
    consumer,
    run.manager,
    {
      typescript: "latest",
      "@types/node": "latest",
      ...packed.manifest.peerDependencies,
      ...overrides,
    },
    overrides,
  );
  const install = await runCommand(
    run.manager,
    INSTALL_ARGUMENTS[run.manager],
    { cwd: consumer, signal: run.signal },
  );
  if (install.status !== 0)
    return `Installing the tarball failed:\n${install.output}`;
  return typecheck(run, consumer, typed, packed.manifest);
}

function packsWithPnpmOrNpm(
  manager: PackageManager,
): manager is "pnpm" | "npm" {
  return manager === "pnpm" || manager === "npm";
}

/**
 * Packs each package `typedPackages` finds, running its `prepack`, and installs the tarball alone in a scratch
 * directory with its peers, optional ones included, `typescript` and `@types/node` at the latest version unless it
 * names them as peers, and the tarball of each package of the repository it depends on in place of the registry's.
 * Then runs `tsc` with `skipLibCheck` off over a consumer file importing each entry its `exports` names, or, without
 * `exports`, the package itself and every declaration file it ships. Returns what failed, each package's errors under
 * its `package.json`, empty when every package passed.
 */
export async function checkPublishedTypes(
  root: string,
  signal?: AbortSignal,
): Promise<string> {
  const manager = packageManager(
    parseManifest(readFileSync(join(root, "package.json"), "utf8")),
  );
  if (!packsWithPnpmOrNpm(manager))
    return `This check packs with pnpm or npm, not ${manager}.\n`;
  const scratch = realpathSync.native(
    mkdtempSync(join(tmpdir(), "published-types-")),
  );
  const members = new Map(
    publicPackages(root).map(({ name, directory }) => [name, directory]),
  );
  const run: Run = {
    root,
    manager,
    scratch,
    signal,
    members,
    packs: new Map(),
  };
  let failures = "";
  try {
    for (const [slot, typed] of typedPackages(root).entries()) {
      if (signal?.aborted) break;
      const failure = await consumerErrors(run, typed, slot);
      if (failure)
        failures += `${join(typed.directory, "package.json")}: ${typed.name} as a consumer installs it, checked by tsc with skipLibCheck off:\n${failure}`;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return failures;
}
