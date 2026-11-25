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
import {
  type KnownFailure,
  KNOWN_FAILURES_FILE,
  describeEntry,
  readKnownFailures,
  splitDiagnostics,
} from "./known-failures.ts";
import { packTarball } from "./pack-tarball.ts";
import { runCommand } from "./run-command.ts";
import { tarEntry } from "./tar-entry.ts";

/** A package of the repository that publishes declarations: its directory relative to the root, `""` for the root, and its `name`. */
interface TypedPackage {
  directory: string;
  name: string;
}

/** A packed package: why packing failed, else the tarball and the manifest it holds. */
type Packed =
  | { failure: string }
  | { failure: ""; tarball: string; manifest: Manifest };

/** One run of the check: the packages of the repository a consumer could install, by name, each one packed so far, the known failures the repository declares, and those an error matched so far. */
interface Run {
  root: string;
  manager: "pnpm" | "npm";
  scratch: string;
  signal: AbortSignal | undefined;
  members: Map<string, string>;
  packs: Map<string, Packed>;
  declared: KnownFailure[];
  matched: Set<KnownFailure>;
}

/** What checking one package found: the errors that fail it, the declared ones, and whether tsc ran over it. */
interface Checked {
  failure: string;
  known: string[];
  compiled: boolean;
}

function unchecked(failure: string): Checked {
  return { failure, known: [], compiled: false };
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

function packedManifest(destination: string): Packed {
  const [file = ""] = readdirSync(destination);
  const tarball = join(destination, file);
  const text = tarEntry(readFileSync(tarball), "package/package.json");
  return text === undefined
    ? { failure: `${file} holds no package/package.json.\n` }
    : { failure: "", tarball, manifest: parseManifest(text) };
}

/** Packs the package `name` once per run through {@link packTarball} and reads the manifest its tarball holds. */
async function pack(run: Run, name: string): Promise<Packed> {
  const cached = run.packs.get(name);
  if (cached) return cached;
  const slot = String(run.packs.size);
  const destination = join(run.scratch, "tarballs", slot);
  mkdirSync(destination, { recursive: true });
  const result = await packTarball(
    run.manager,
    join(run.root, run.members.get(name) ?? ""),
    destination,
    run.signal,
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
  if (tsc.status === 0) return { failure: "", known: [], compiled: true };
  const { known, unknown } = splitDiagnostics(
    tsc.output,
    run.declared,
    run.matched,
  );
  const failure =
    unknown.length || !known.length
      ? readable(
          unknown.length
            ? `${unknown.join("\n")}\n`
            : `tsc exited with status ${String(tsc.status)}.\n`,
          consumer,
          typed.name,
        )
      : "";
  return { failure, known, compiled: true };
}

async function consumerErrors(
  run: Run,
  typed: TypedPackage,
  slot: number,
): Promise<Checked> {
  const packed = await pack(run, typed.name);
  if (!("tarball" in packed)) return unchecked(packed.failure);
  const siblings = await siblingTarballs(run, typed.name, packed.manifest);
  if (siblings.failure) return unchecked(siblings.failure);
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
    return unchecked(`Installing the tarball failed:\n${install.output}`);
  return typecheck(run, consumer, typed, packed.manifest);
}

function packsWithPnpmOrNpm(
  manager: PackageManager,
): manager is "pnpm" | "npm" {
  return manager === "pnpm" || manager === "npm";
}

/** What one run of {@link checkPublishedTypes} found: what failed, empty when it passed, and the errors the repository declares as known. */
interface PublishedTypesReport {
  failure: string;
  notes: string;
}

/** The line that fails each entry of `run` no error matched, once tsc ran over every package. */
function staleEntries(run: Run): string {
  return run.declared
    .filter((entry) => !run.matched.has(entry))
    .map(
      (entry) =>
        `${KNOWN_FAILURES_FILE}: ${describeEntry(entry)} no longer occurs. Remove the entry.\n`,
    )
    .join("");
}

/**
 * Packs each package `typedPackages` finds, running its `prepack`, and installs the tarball alone in a scratch
 * directory with its peers, optional ones included, `typescript` and `@types/node` at the latest version unless it
 * names them as peers, and the tarball of each package of the repository it depends on in place of the registry's.
 * Then runs `tsc` with `skipLibCheck` off over a consumer file importing each entry its `exports` names, or, without
 * `exports`, the package itself and every declaration file it ships. An error in a dependency's declarations that
 * `guardrails.published-types.json` declares is reported under `notes` instead of failing; an entry no error matched
 * fails once tsc ran over every package. Each package's errors are listed under its `package.json`.
 */
export async function checkPublishedTypes(
  root: string,
  signal?: AbortSignal,
): Promise<PublishedTypesReport> {
  const manager = packageManager(
    parseManifest(readFileSync(join(root, "package.json"), "utf8")),
  );
  if (!packsWithPnpmOrNpm(manager))
    return {
      failure: `This check packs with pnpm or npm, not ${manager}.\n`,
      notes: "",
    };
  const members = new Map(
    publicPackages(root).map(({ name, directory }) => [name, directory]),
  );
  const declared = readKnownFailures(root, new Set(members.keys()));
  if (!("entries" in declared)) return { failure: declared.failure, notes: "" };
  const scratch = realpathSync.native(
    mkdtempSync(join(tmpdir(), "published-types-")),
  );
  const run: Run = {
    root,
    manager,
    scratch,
    signal,
    members,
    packs: new Map(),
    declared: declared.entries,
    matched: new Set(),
  };
  let failure = "";
  let notes = "";
  let complete = true;
  try {
    for (const [slot, typed] of typedPackages(root).entries()) {
      if (signal?.aborted) break;
      const checked = await consumerErrors(run, typed, slot);
      complete &&= checked.compiled;
      const header = `${join(typed.directory, "package.json")}: ${typed.name} as a consumer installs it, checked by tsc with skipLibCheck off`;
      if (checked.failure) failure += `${header}:\n${checked.failure}`;
      if (checked.known.length)
        notes += `${header}, errors ${KNOWN_FAILURES_FILE} declares as known:\n${checked.known.join("\n")}\n`;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (complete && !signal?.aborted) failure += staleEntries(run);
  return { failure, notes };
}
