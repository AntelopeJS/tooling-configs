import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, join, matchesGlob, relative, resolve } from "node:path";

import {
  AGENT_IGNORE_PATTERNS,
  IGNORE_PATTERNS,
  SYNCED_AGENT_PATTERNS,
} from "../oxc/shared.ts";
import { MAX_FILE_BYTES } from "./ceilings.ts";

const SIZE_EXCLUSIONS = [
  {
    kind: "generated",
    patterns: [
      ...IGNORE_PATTERNS,
      ...SYNCED_AGENT_PATTERNS,
      "**/*.generated.*",
      "**/generated/**",
      "**/__snapshots__/**",
    ],
  },
  { kind: "fixtures", patterns: ["**/fixtures/**", "**/__fixtures__/**"] },
  { kind: "data", patterns: ["**/*.{json,jsonc,json5}"] },
  {
    kind: "lockfiles",
    patterns: [
      "**/{pnpm-lock.yaml,package-lock.json,npm-shrinkwrap.json,yarn.lock,bun.lock,bun.lockb,Cargo.lock,poetry.lock,uv.lock,Gemfile.lock,composer.lock,go.sum}",
      "**/*.lock",
      "**/*.lockb",
    ],
  },
  {
    kind: "documentation",
    patterns: ["**/CHANGELOG.md", "**/*.{md,mdx,markdown,MD}"],
  },
  {
    kind: "assets",
    patterns: [
      "**/*.{png,jpg,jpeg,gif,webp,avif,ico,svg,bmp,tiff,pdf,mp3,wav,ogg,flac,mp4,webm,mov,avi,woff,woff2,ttf,otf,eot,zip,gz,tgz,bz2,xz,7z,tar,rar,wasm,bin,exe,dll,so,dylib,db,sqlite,sqlite3,icns}",
    ],
  },
];

/** A lint configuration file, which a measurement at an earlier revision keeps at its current content. */
export const LINT_CONFIG =
  /(?:^|\/)(?:oxlint\.config\.[cm]?[jt]s|\.oxlintrc\.jsonc?)$/u;

export function trackedManifests(root: string): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(
      (file) => file === "package.json" || file.endsWith("/package.json"),
    );
}

export function gitFiles(root: string): string[] {
  return [
    ...new Set(
      execFileSync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        { cwd: root, encoding: "utf8" },
      )
        .split("\0")
        .filter(Boolean),
    ),
  ];
}

/** Files that differ from HEAD in the working tree, untracked ones included; every file before the first commit. */
export function changedFiles(root: string): Set<string> {
  if (
    spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: root,
      stdio: "ignore",
    }).status !== 0
  )
    return new Set(gitFiles(root));
  const tracked = execFileSync("git", ["diff", "HEAD", "--name-only", "-z"], {
    cwd: root,
    encoding: "utf8",
  });
  const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  );
  return new Set(`${tracked}${untracked}`.split("\0").filter(Boolean));
}

export function repositoryRoot(cwd = process.cwd()): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  }).trim();
}

/** Resolves a user-supplied revision to a commit id, so it can never read as an option. */
export function resolveRevision(root: string, revision: string): string {
  return execFileSync(
    "git",
    ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

export function repositoryPath(root: string, file: string): string {
  return relative(root, resolve(root, file)).split("\\").join("/");
}

function fileBytes(
  root: string,
  file: string,
  staged = false,
): number | undefined {
  if (staged) {
    const result = spawnSync("git", ["cat-file", "-s", `:${file}`], {
      cwd: root,
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    return result.status === 0 ? Number(result.stdout.trim()) : undefined;
  }
  const path = join(root, file);
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  return stat.isFile() ? stat.size : undefined;
}

/** A package root is the directory of a tracked manifest outside every `src` directory; its top-level `build` and `output` are generated output. */
function packageOutputPatterns(root: string): string[] {
  return trackedManifests(root).flatMap((manifest) => {
    const directory = dirname(manifest);
    if (directory === "." || directory.split("/").includes("src")) return [];
    return [`${directory}/build/**`, `${directory}/output/**`];
  });
}

/** `path.matchesGlob` never lets `*` or `**` cross a segment starting with a dot, so each path is also tried with those dots removed. */
function isExcluded(
  file: string,
  packageOutputs: string[],
  exclusions = SIZE_EXCLUSIONS,
): boolean {
  const undotted = file.replace(/(^|\/)\./gu, "$1");
  const matches = (pattern: string) =>
    matchesGlob(file, pattern) || matchesGlob(undotted, pattern);
  return (
    exclusions.some(({ patterns }) => patterns.some(matches)) ||
    packageOutputs.some(matches)
  );
}

function isBinary(root: string, file: string, staged: boolean): boolean {
  if (staged) {
    const blob = execFileSync("git", ["show", `:${file}`], {
      cwd: root,
      maxBuffer: fileBytes(root, file, true),
    });
    return blob.subarray(0, 8000).includes(0);
  }
  const descriptor = openSync(join(root, file), "r");
  try {
    const prefix = Buffer.alloc(8000);
    const length = readSync(descriptor, prefix, 0, prefix.length, 0);
    return prefix.subarray(0, length).includes(0);
  } finally {
    closeSync(descriptor);
  }
}

/** Whether a repository path is in an agent tooling directory, whose repository-authored files the budget records apart from the rest. */
export function isAgentFile(file: string): boolean {
  return AGENT_IGNORE_PATTERNS.some((pattern) =>
    file.startsWith(pattern.slice(0, -"**".length)),
  );
}

/** Whether a repository path is generated output the budget and the size guard skip: `dist`, `.nuxt`, the agent files `antelopejs-sync` writes, `*.generated.*`, snapshots, and package-root `build` or `output`. */
export function generatedOutput(root: string): (file: string) => boolean {
  const packageOutputs = packageOutputPatterns(root);
  const generated = SIZE_EXCLUSIONS.filter(({ kind }) => kind === "generated");
  return (file) => isExcluded(file, packageOutputs, generated);
}

export function authoredSizes(
  root: string,
  files = gitFiles(root),
  staged = false,
): Map<string, number> {
  const sizes = new Map<string, number>();
  const packageOutputs = packageOutputPatterns(root);
  for (const input of files) {
    const file = repositoryPath(root, input);
    if (isExcluded(file, packageOutputs)) continue;
    const size = fileBytes(root, file, staged);
    if (
      size !== undefined &&
      size > MAX_FILE_BYTES &&
      isBinary(root, file, staged)
    )
      continue;
    if (size !== undefined) sizes.set(file, size);
  }
  return sizes;
}
