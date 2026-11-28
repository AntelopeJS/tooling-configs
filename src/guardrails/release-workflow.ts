import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from "yaml";

import { parseManifest } from "./package.ts";
import type { PlannedArtifact } from "./sync.ts";
import { sharedWorkflow } from "./workflow.ts";

const WORKFLOWS = ".github/workflows";
export const RELEASE_PATH = `${WORKFLOWS}/release.yml`;
export const NEXT_SYNC_PATH = `${WORKFLOWS}/next-sync.yml`;

const RELEASE_CALLER =
  /^AntelopeJS\/\.github\/\.github\/workflows\/release-npm-(public|private)\.yml@\S+$/;

/** A package the repository publishes through a shared release workflow. */
interface ReleasePackage {
  /** The package directory relative to the repository root, `.` for the root package. */
  directory: string;
  /** The shared workflow that publishes it: `public` to npmjs, `private` to the AntelopeJS registry. */
  registry: "public" | "private";
  /** The `install-core` the caller set, kept as written; absent leaves the shared workflow's default. */
  installCore?: boolean;
}

/** The release callers sync found in the repository's workflows: the packages, and the files and inputs the canonical caller drops. */
interface ReleaseCallers {
  packages: ReleasePackage[];
  files: Map<string, string>;
  dropped: string[];
  errors: string[];
}

/** The caller of next-sync.yml, which merges `main` into `branch` after each push to `main` or a manual dispatch; next-sync.yml needs `issues: write`. */
function nextSyncCaller(branch: string): string {
  return `name: Next sync

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions: {}

jobs:
  next-sync:
    permissions:
      issues: write
    uses: ${sharedWorkflow("next-sync.yml")}
    with:
      branch: ${branch}
    secrets:
      RELEASE_APP_ID: \${{ secrets.RELEASE_APP_ID }}
      RELEASE_APP_PRIVATE_KEY: \${{ secrets.RELEASE_APP_PRIVATE_KEY }}
      NOTION_TOKEN: \${{ secrets.NOTION_TOKEN }}
`;
}

/** The next-sync.yml of a repository with an integration branch, which keeps that branch level with `main`; a trunk repository has none. */
export function nextSyncArtifacts(
  root: string,
  integrationBranch: string | undefined,
): PlannedArtifact[] {
  if (integrationBranch === undefined) return [];
  const content = nextSyncCaller(integrationBranch);
  const path = join(root, NEXT_SYNC_PATH);
  return existsSync(path) && readFileSync(path, "utf8") === content
    ? [{ kind: "unchanged", path: NEXT_SYNC_PATH }]
    : [{ kind: "write", path: NEXT_SYNC_PATH, content, mode: undefined }];
}

function normalizeDirectory(path: string): string {
  return path.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "") || ".";
}

function choiceOptions(document: YAMLMap, input: string): string[] {
  const on = document.get("on", true);
  const options = isMap(on)
    ? on.getIn(["workflow_dispatch", "inputs", input, "options"], true)
    : undefined;
  return isSeq(options)
    ? options.items.flatMap((item) =>
        isScalar(item) ? [String(item.value)] : [],
      )
    : [];
}

/** The directories a caller's `package-directory` names: a path, a release-train input with a fallback path, or a dispatch input whose choices, between an optional prefix and suffix, are paths. */
function directoriesOf(root: YAMLMap, text: string | undefined): string[] {
  if (text === undefined) return ["."];
  if (!text.includes("${{")) return [normalizeDirectory(text)];
  const fallback = /^\$\{\{\s*inputs\.[\w-]+\s*\|\|\s*'([^']+)'\s*\}\}$/.exec(
    text,
  );
  if (fallback) return [normalizeDirectory(fallback[1])];
  const input = /^([^$]*)\$\{\{\s*inputs\.([\w-]+)\s*\}\}([^$]*)$/.exec(text);
  if (!input) return [];
  const [, prefix, name, suffix] = input;
  return choiceOptions(root, name).map((option) =>
    normalizeDirectory(`${prefix}${option}${suffix}`),
  );
}

function droppedInputs(job: YAMLMap): string[] {
  const inputs = job.get("with", true);
  if (!isMap(inputs)) return [];
  return inputs.items.flatMap(({ key }) =>
    isScalar(key) &&
    ![
      "release-version",
      "release-commit",
      "dependency-ranges",
      "install-core",
      "package-directory",
    ].includes(String(key.value))
      ? [String(key.value)]
      : [],
  );
}

function needsOf(job: YAMLMap): string[] {
  const needs: unknown = job.get("needs", true);
  if (isScalar(needs)) return [String(needs.value)];
  return isSeq(needs)
    ? needs.items.flatMap((item) =>
        isScalar(item) ? [String(item.value)] : [],
      )
    : [];
}

function addPackage(
  found: ReleaseCallers,
  release: ReleasePackage,
  where: string,
): void {
  const known = found.packages.find(
    ({ directory }) => directory === release.directory,
  );
  if (!known) found.packages.push(release);
  else if (known.registry !== release.registry)
    found.errors.push(
      `${where}: ${release.directory} is released to both the public and the private registry. Keep one caller, then rerun antelopejs-sync.`,
    );
}

function readCallers(file: string, text: string, found: ReleaseCallers): void {
  const document = parseDocument(text);
  const root = document.contents;
  const jobs = document.errors.length ? undefined : document.get("jobs", true);
  if (!isMap(root) || !isMap(jobs)) return;
  const callers = jobs.items.filter(
    ({ value }) =>
      isMap(value) && RELEASE_CALLER.test(String(value.get("uses"))),
  );
  if (!callers.length) return;
  found.files.set(file, text);
  const needed = new Set(
    callers.flatMap(({ value }) => (isMap(value) ? needsOf(value) : [])),
  );
  for (const { key, value } of jobs.items) {
    if (!isMap(value)) continue;
    const id = String(isScalar(key) ? key.value : key);
    const registry = RELEASE_CALLER.exec(String(value.get("uses")))?.[1];
    if (registry !== "public" && registry !== "private") {
      if (needed.has(id)) found.dropped.push(`job ${id} of ${file}`);
      else
        found.errors.push(
          `${file}: the job ${id} is not part of the release, and sync moves the release callers of this file into ${RELEASE_PATH}. Move ${id} to a workflow file of its own, then rerun antelopejs-sync.`,
        );
      continue;
    }
    found.dropped.push(
      ...droppedInputs(value).map((input) => `input ${input} of ${file}`),
    );
    const inputs = value.get("with", true);
    const directoryNode = isMap(inputs)
      ? inputs.get("package-directory", true)
      : undefined;
    const directory = isScalar(directoryNode)
      ? String(directoryNode.value)
      : undefined;
    const installCore = isMap(inputs) ? inputs.get("install-core") : undefined;
    const directories = directoriesOf(root, directory);
    if (!directories.length)
      found.errors.push(
        `${file}: the job ${id} sets package-directory to ${directory}, which names no package directory. Set it to the package's directory, then rerun antelopejs-sync.`,
      );
    for (const path of directories) {
      const release: ReleasePackage = { directory: path, registry };
      if (installCore === true || installCore === false)
        release.installCore = installCore;
      addPackage(found, release, file);
    }
  }
}

/** Every job of `.github/workflows` that calls release-npm-public.yml or release-npm-private.yml, at any ref. */
function releaseCallers(root: string): ReleaseCallers {
  const found: ReleaseCallers = {
    packages: [],
    files: new Map(),
    dropped: [],
    errors: [],
  };
  const directory = join(root, WORKFLOWS);
  if (!existsSync(directory)) return found;
  for (const name of readdirSync(directory)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()) {
    const file = `${WORKFLOWS}/${name}`;
    readCallers(file, readFileSync(join(root, file), "utf8"), found);
  }
  found.packages.sort((a, b) => a.directory.localeCompare(b.directory));
  return found;
}

function jobId(release: ReleasePackage, several: boolean): string {
  if (!several) return "release";
  return release.directory === "."
    ? "release-root"
    : `release-${release.directory.replaceAll("/", "-")}`;
}

/** The condition under which a dispatch runs the job of `directory`: a release-train dispatch for it, which leaves `package-directory` out for the root package, or a preview dispatch that names no package. */
function dispatched(directory: string): string {
  return directory === "."
    ? "inputs.package-directory == '' || inputs.package-directory == '.'"
    : `inputs.package-directory == '${directory}' || inputs.preview == true && inputs.package-directory == ''`;
}

const RUNTIME_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/** The released siblings each package depends on at runtime, by directory, read from the package manifests under `root`. */
function siblingsOf(
  root: string,
  packages: readonly ReleasePackage[],
): Map<string, ReleasePackage[]> {
  const manifests = packages.map((release) => {
    const path = join(root, release.directory, "package.json");
    return {
      release,
      manifest: existsSync(path)
        ? parseManifest(readFileSync(path, "utf8"))
        : {},
    };
  });
  return new Map(
    manifests.map(({ release, manifest }) => {
      const names = new Set(
        RUNTIME_FIELDS.flatMap((field) => Object.keys(manifest[field] ?? {})),
      );
      return [
        release.directory,
        manifests.flatMap((other) =>
          other.release !== release &&
          other.manifest.name !== undefined &&
          names.has(other.manifest.name)
            ? [other.release]
            : [],
        ),
      ];
    }),
  );
}

/** The `needs` and `if` of a job among several: it waits for the siblings it depends on, and runs when none of them failed, so a skipped sibling leaves it free. */
function gate(release: ReleasePackage, siblings: ReleasePackage[]): string[] {
  const condition = `github.event_name != 'workflow_dispatch' || ${dispatched(release.directory)}`;
  if (!siblings.length) return [`    if: ${condition}`];
  return [
    "    needs:",
    ...siblings.map((sibling) => `      - ${jobId(sibling, true)}`),
    `    if: \${{ !failure() && !cancelled() && (${condition}) }}`,
  ];
}

function releaseJob(
  release: ReleasePackage,
  siblings: ReleasePackage[] | undefined,
): string {
  const several = siblings !== undefined;
  const nested = release.directory !== ".";
  const lines = [
    `  ${jobId(release, several)}:`,
    ...(several ? gate(release, siblings) : []),
    `    uses: ${sharedWorkflow(`release-npm-${release.registry}.yml`)}`,
    "    with:",
    "      release-version: ${{ inputs.release-version }}",
    "      release-commit: ${{ inputs.release-commit }}",
    "      dependency-ranges: ${{ inputs.dependency-ranges }}",
    "      preview: ${{ inputs.preview == true }}",
    ...(release.installCore === undefined
      ? []
      : [`      install-core: ${release.installCore}`]),
    ...(!nested
      ? []
      : several
        ? [`      package-directory: ${release.directory}`]
        : [
            `      package-directory: \${{ inputs.package-directory || '${release.directory}' }}`,
          ]),
    "    secrets:",
    "      RELEASE_APP_ID: ${{ secrets.RELEASE_APP_ID }}",
    "      RELEASE_APP_PRIVATE_KEY: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}",
    ...(release.registry === "private"
      ? ["      NPM_ANTELOPE_TOKEN: ${{ secrets.NPM_ANTELOPE_TOKEN }}"]
      : []),
  ];
  return lines.map((line) => `${line}\n`).join("");
}

/**
 * The release.yml that publishes `packages`: a `next` preview on a dispatch with `preview: true`, a pull request preview on
 * each label, push or reopen of a pull request that carries the `preview` label, and the stable version the release train
 * dispatches on the default branch with `release-version`, `release-commit`, `dependency-ranges` and, when a package is
 * not at the root, `package-directory`. The shared workflow skips a pull request without the `preview` label. With several
 * packages, each has its own job, which a dispatch runs only for the `package-directory` it names, or, on a preview
 * dispatch that names none, for every package, each after the siblings it depends on at runtime. A single root package
 * gets AntelopeJS/.github's scripts/release-train/frozen-caller.yml byte for byte.
 */
function releaseCaller(
  packages: readonly ReleasePackage[],
  siblings: Map<string, ReleasePackage[]>,
): string {
  const several = packages.length > 1;
  const nested = packages.some(({ directory }) => directory !== ".");
  const directoryInput = nested
    ? `      package-directory:
        description: Directory of the package to release, set by the release train
        required: false
        type: string
`
    : "";
  const idToken = packages.some(({ registry }) => registry === "public")
    ? "  id-token: write\n"
    : "";
  return `name: Release

on:
  pull_request:
    types: [labeled, synchronize, reopened]
  workflow_dispatch:
    inputs:
      release-version:
        description: Stable version to release, set by the release train
        required: false
        type: string
      release-commit:
        description: Commit SHA to release, set by the release train
        required: false
        type: string
      dependency-ranges:
        description: JSON object of stable ranges that replace preview pins, set by the release train
        required: false
        default: "{}"
        type: string
      preview:
        description: Publish a preview under the npm dist-tag next from the default branch or a work/* branch
        required: false
        default: false
        type: boolean
${directoryInput}
permissions:
  contents: write
${idToken}
jobs:
${packages.map((release) => releaseJob(release, several ? (siblings.get(release.directory) ?? []) : undefined)).join("\n")}`;
}

/**
 * Brings every release caller of the repository into one release.yml at the shared tag, so the release train, which
 * dispatches release.yml only, reaches each package, and npm trusted publishing sees one calling workflow file. Each
 * other workflow file that held a release caller is removed. Inputs the shared workflows no longer take (`channel`,
 * `services-compose-file`) and jobs besides the callers, such as a metadata `validate` job, are dropped and named in
 * a note. A repository with no release caller publishes nothing, and nothing is written.
 */
export function releaseArtifacts(root: string): PlannedArtifact[] {
  const found = releaseCallers(root);
  if (found.errors.length)
    return found.errors.map((message) => ({
      kind: "error",
      path: RELEASE_PATH,
      message,
    }));
  if (!found.packages.length) return [];
  const content = releaseCaller(
    found.packages,
    siblingsOf(root, found.packages),
  );
  const removed = [...found.files.keys()].filter(
    (file) => file !== RELEASE_PATH,
  );
  const artifacts: PlannedArtifact[] = removed.map((path) => ({
    kind: "remove",
    path,
  }));
  if (found.files.get(RELEASE_PATH) === content)
    return [...artifacts, { kind: "unchanged", path: RELEASE_PATH }];
  const notes = [
    ...found.dropped.map(
      (item) =>
        `Dropped ${item}: release-npm-*.yml@v2 validates the package metadata, takes no channel and runs no tests.`,
    ),
    ...removed.map(
      (file) =>
        `Moved the release caller of ${file} into ${RELEASE_PATH}, the only workflow the release train dispatches. Point the package's npm trusted publisher at release.yml.`,
    ),
  ];
  return [
    ...artifacts,
    notes.length
      ? {
          kind: "migrated",
          path: RELEASE_PATH,
          content,
          mode: undefined,
          notes,
        }
      : { kind: "write", path: RELEASE_PATH, content, mode: undefined },
  ];
}
