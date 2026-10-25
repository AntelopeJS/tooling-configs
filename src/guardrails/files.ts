import { execFileSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { join, matchesGlob, relative, resolve } from "node:path";

import { AGENT_IGNORE_PATTERNS, IGNORE_PATTERNS } from "../oxc/shared.ts";

export const SIZE_EXCLUSIONS = [
  {
    kind: "generated",
    patterns: [
      ...IGNORE_PATTERNS,
      ...AGENT_IGNORE_PATTERNS,
      "**/*.generated.*",
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

export function fileBytes(root: string, file: string): number | undefined {
  const path = join(root, file);
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  return stat.isFile() ? stat.size : undefined;
}

export function authoredSizes(
  root: string,
  files = gitFiles(root),
): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const input of files) {
    const file = repositoryPath(root, input);
    if (
      SIZE_EXCLUSIONS.some(({ patterns }) =>
        patterns.some((pattern) => matchesGlob(file, pattern)),
      )
    )
      continue;
    const size = fileBytes(root, file);
    if (size !== undefined) sizes.set(file, size);
  }
  return sizes;
}
