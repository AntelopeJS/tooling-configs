import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { isObject, parseJson, type JsonObject } from "../garden/json.ts";
import { skillFolder, type VerifyKind } from "./kinds.ts";
import type { VerifyConfig } from "./types.ts";

/** The repository under verification, its kind and its repo-owned layer. */
export interface Workspace {
  root: string;
  kind: VerifyKind;
  /** The skill folder, `.agents/skills/verify-<kind>`, absolute. */
  skill: string;
  config: VerifyConfig<never>;
  /** The root package.json. */
  manifest: JsonObject;
  /** Short repository name for run folders and container names. */
  name: string;
}

/** A process a run started in the background, found again by its PID. */
interface ProcessRecord {
  name: string;
  pid: number;
}

/** A Docker container a run started, removed by name on clean. */
export interface ContainerRecord {
  service: string;
  name: string;
  host: string;
  port: number;
}

/** The persisted state of one isolated run. */
export interface RunState {
  id: string;
  kind: VerifyKind;
  repo: string;
  dir: string;
  evidence: string;
  createdAt: string;
  headSha: string;
  baseRef: string;
  /** The change title the interface minor rule reads; empty means the commit subjects since the base. */
  title: string;
  processes: ProcessRecord[];
  containers: ContainerRecord[];
  /** Interface kind: the packed head package, extracted. */
  pack: string;
  /** Template kind: the offline manifest repository URL. */
  manifestUrl: string;
  templateName: string;
  /** Provider sandbox keys missing from the environment. */
  missingKeys: string[];
}

/**
 * Caches shared by every run: the warm pnpm store, the npm cache and the
 * published packages. Nothing a journey asserts on lives here.
 */
export const CACHE_DIR = join(
  process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
  "antelopejs-verify",
);

/** Runs git in `cwd` and returns its trimmed output. */
export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function readManifest(root: string): JsonObject {
  const file = join(root, "package.json");
  const value = existsSync(file) ? parseJson(readFileSync(file, "utf8")) : {};
  return isObject(value) ? value : {};
}

/** Opens the repository at `root` for `kind`, loading the repo-owned verify.config.ts. */
export async function openWorkspace(
  root: string,
  kind: VerifyKind,
): Promise<Workspace> {
  const skill = join(root, skillFolder(kind));
  const file = join(skill, "verify.config.ts");
  if (!existsSync(file))
    throw new Error(
      `${file} is missing. Write the repo-owned layer (verify.config.ts and features/) described in ${skillFolder(kind)}/SKILL.md.`,
    );
  const loaded = await import(pathToFileURL(file).href);
  const config: VerifyConfig<never> | undefined = loaded.default;
  if (config?.doors === undefined)
    throw new Error(
      `${file} must export default a VerifyConfig with a doors block.`,
    );
  const manifest = readManifest(root);
  const packageName = String(manifest.name ?? basename(root));
  return {
    root,
    kind,
    skill,
    config,
    manifest,
    name: packageName.replace(/^@[^/]+\//, "").replace(/[^a-z0-9-]+/gi, "-"),
  };
}

function stateFile(dir: string): string {
  return join(dir, "run.json");
}

/** Reads a run created by `new`, failing with the reason when it is missing. */
export function loadRun(dir: string): RunState {
  const file = stateFile(resolve(dir));
  if (!existsSync(file))
    throw new Error(
      `No run at ${dir}: run.json is missing. Create one with \`new\`.`,
    );
  const state: RunState = JSON.parse(readFileSync(file, "utf8"));
  return state;
}

/** Persists the run state. */
export function saveRun(state: RunState): void {
  writeFileSync(stateFile(state.dir), `${JSON.stringify(state, null, 2)}\n`);
}

/** Allocates the folders of a new run under the system temp folder. */
export function allocateRun(
  workspace: Workspace,
  baseRef: string,
  title: string,
): RunState {
  const id = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`;
  const dir = join(tmpdir(), "antelopejs-verify", workspace.name, id);
  const evidence = join(dir, "evidence");
  mkdirSync(evidence, { recursive: true });
  return {
    id,
    kind: workspace.kind,
    repo: workspace.root,
    dir,
    evidence,
    createdAt: new Date().toISOString(),
    headSha: git(workspace.root, ["rev-parse", "HEAD"]),
    baseRef,
    title,
    processes: [],
    containers: [],
    pack: "",
    manifestUrl: "",
    templateName: "",
    missingKeys: (workspace.config.saas?.env ?? []).filter(
      (key) => !process.env[key],
    ),
  };
}

const INHERITED_PREFIXES = ["ANTELOPEJS_", "npm_", "PNPM_", "XDG_"];

/**
 * The environment every driven command gets: the journey's HOME, CI=1, no
 * update check, no colors and the shared caches. Variables that could leak
 * the operator's own settings into the run are dropped.
 */
export function isolatedEnv(
  workspace: Workspace,
  home: string,
  extra: { [name: string]: string } = {},
): NodeJS.ProcessEnv {
  const kept = Object.entries(process.env).filter(
    ([key]) => !INHERITED_PREFIXES.some((prefix) => key.startsWith(prefix)),
  );
  return {
    ...Object.fromEntries(kept),
    HOME: home,
    USERPROFILE: home,
    CI: "1",
    AJS_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    COREPACK_HOME:
      process.env.COREPACK_HOME ??
      join(homedir(), ".cache", "node", "corepack"),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    XDG_DATA_HOME: join(CACHE_DIR, "xdg-data"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    npm_config_cache: join(CACHE_DIR, "npm"),
    npm_config_prefer_offline: "true",
    GIT_CONFIG_NOSYSTEM: "1",
    ...workspace.config.env,
    ...extra,
  };
}
