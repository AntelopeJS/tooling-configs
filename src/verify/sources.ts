import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { git, type RunState, type Workspace } from "./workspace.ts";

const IDENTITY = [
  "-c",
  "user.name=antelopejs-verify",
  "-c",
  "user.email=verify@antelopejs.invalid",
  "-c",
  "init.defaultBranch=main",
  "-c",
  "commit.gpgsign=false",
];

function commitFolder(folder: string): void {
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["commit", "-q", "-m", "verify source"],
  ])
    execFileSync("git", [...IDENTITY, ...args], {
      cwd: folder,
      stdio: "ignore",
    });
}

function bare(source: string, target: string): string {
  execFileSync("git", ["clone", "-q", "--bare", source, target], {
    stdio: "ignore",
  });
  return pathToFileURL(target).href;
}

function copyWorkingTree(root: string, target: string): void {
  const files = git(root, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ])
    .split("\0")
    .filter(Boolean);
  for (const file of new Set(files)) {
    const source = join(root, file);
    const stat = lstatSync(source, { throwIfNoEntry: false });
    if (stat === undefined || existsSync(join(target, file))) continue;
    mkdirSync(dirname(join(target, file)), { recursive: true });
    if (stat.isSymbolicLink())
      symlinkSync(readlinkSync(source), join(target, file));
    else copyFileSync(source, join(target, file));
  }
}

/** The template name the offline manifest lists, the repository's own unless verify.config.ts names one. */
export function templateName(workspace: Workspace): string {
  return workspace.config.template?.name ?? `Verify ${workspace.name}`;
}

/**
 * Builds the offline template source of a run: the template's working tree,
 * uncommitted changes included, as a local git repository, and an interfaces
 * repository whose manifest.json lists it through a `file://` URL. Returns
 * the manifest repository URL `ajs config set git` points at.
 */
export function seedSources(workspace: Workspace, state: RunState): string {
  const sources = join(state.dir, "sources");
  const template = join(sources, "template");
  mkdirSync(template, { recursive: true });
  copyWorkingTree(workspace.root, template);
  commitFolder(template);
  const templateUrl = bare(template, join(sources, "template.git"));
  const manifest = join(sources, "interfaces");
  mkdirSync(manifest, { recursive: true });
  const listing = workspace.config.template?.project
    ? "projectTemplates"
    : "templates";
  const entry = {
    name: templateName(workspace),
    repository: templateUrl,
    branch: "main",
    packageManager: "pnpm",
  };
  const content = {
    interfaces: {},
    starredInterfaces: [],
    templates: [],
    projectTemplates: [],
    [listing]: [entry],
  };
  writeFileSync(
    join(manifest, "manifest.json"),
    `${JSON.stringify(content, null, 2)}\n`,
  );
  commitFolder(manifest);
  return bare(manifest, join(sources, "interfaces.git"));
}
