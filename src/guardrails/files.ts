import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { join, matchesGlob, relative, resolve } from "node:path";

import { AGENT_IGNORE_PATTERNS, IGNORE_PATTERNS } from "../oxc/shared.ts";

const SIZE_EXCLUSIONS = [
  {
    kind: "generated",
    patterns: [
      ...IGNORE_PATTERNS,
      ...AGENT_IGNORE_PATTERNS,
      "**/*.generated.*",
      "**/generated/**",
      "**/__snapshots__/**",
    ],
  },
  { kind: "fixtures", patterns: ["**/fixtures/**", "**/__fixtures__/**"] },
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

export function repositoryRoot(cwd = process.cwd()): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  }).trim();
}

export function repositoryPath(root: string, file: string): string {
  return relative(root, resolve(root, file)).split("\\").join("/");
}

export function fileBytes(
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

/** `path.matchesGlob` never lets `*` or `**` cross a segment starting with a dot, so each path is also tried with those dots removed. */
function isExcluded(file: string): boolean {
  const undotted = file.replace(/(^|\/)\./gu, "$1");
  return SIZE_EXCLUSIONS.some(({ patterns }) =>
    patterns.some(
      (pattern) => matchesGlob(file, pattern) || matchesGlob(undotted, pattern),
    ),
  );
}

export function authoredSizes(
  root: string,
  files = gitFiles(root),
  staged = false,
): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const input of files) {
    const file = repositoryPath(root, input);
    if (isExcluded(file)) continue;
    const size = fileBytes(root, file, staged);
    if (size !== undefined) sizes.set(file, size);
  }
  return sizes;
}
