import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  isObject,
  list,
  num,
  object,
  parseJson,
  str,
  type JsonObject,
} from "../garden/json.ts";
import {
  DEV_STACK_VARIABLES,
  LEASE_DIR,
  LEASE_MARKER,
  leaseTmpDir,
  PARENT_TMPDIR,
} from "../lease/env.ts";
import { skillFolder, type VerifyKind } from "./kinds.ts";
import type { PhaseTiming } from "./timing.ts";
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
  /** Created with `new --all`: the plan runs every feature whatever the diff. An older run.json without it reads as false. */
  all: boolean;
  processes: ProcessRecord[];
  containers: ContainerRecord[];
  /** Interface kind: the packed head package, extracted. */
  pack: string;
  /** Template kind: the offline manifest repository URL. */
  manifestUrl: string;
  templateName: string;
  /** Provider sandbox keys missing from the environment. */
  missingKeys: string[];
  /** How long each phase of `new` took, in the order they ran; empty for a run an older version created. */
  timings: PhaseTiming[];
}

/**
 * Caches shared by every run: the warm pnpm store, the npm cache and the
 * published packages. Nothing a journey asserts on lives here.
 */
export const CACHE_DIR = join(
  process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
  "antelopejs-verify",
);

/**
 * The temp folder the operator would have outside a lease: the `TMPDIR` of
 * `operatorEnv()`, else the platform default, so a lease's own tmp never
 * holds a run.
 */
export function operatorTmpdir(): string {
  const { TMPDIR: tmp, TMP, TEMP } = operatorEnv();
  if (tmp) return tmp;
  if (process.platform === "win32") return tmpdir();
  return TMP || TEMP || "/tmp";
}

/** The folder that holds every run, one subfolder per repository. */
export const RUNS_DIR = join(operatorTmpdir(), "antelopejs-verify");

function makeWritable(folder: string): void {
  chmodSync(folder, lstatSync(folder).mode | 0o700);
  for (const entry of readdirSync(folder, { withFileTypes: true }))
    if (entry.isDirectory()) makeWritable(join(folder, entry.name));
}

/** Deletes a folder this run wrote, including folders an install left read-only. */
export function removeTree(folder: string): void {
  try {
    rmSync(folder, { recursive: true, force: true });
  } catch {
    makeWritable(folder);
    rmSync(folder, { recursive: true, force: true });
  }
}

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

/** Reads a run created by `new`, failing with the reason when it is missing, and marks it active by touching run.json. Its processes are those run.json records and those of every command's records file. */
export function loadRun(dir: string): RunState {
  const file = stateFile(resolve(dir));
  if (!existsSync(file))
    throw new Error(
      `No run at ${dir}: run.json is missing. Create one with \`new\`.`,
    );
  const now = new Date();
  utimesSync(file, now, now);
  const stored: Omit<RunState, "timings" | "all"> & {
    timings?: PhaseTiming[];
    all?: boolean;
  } = JSON.parse(readFileSync(file, "utf8"));
  return {
    ...stored,
    processes: [...stored.processes, ...commandRecords(stored.dir)],
    timings: stored.timings ?? [],
    all: stored.all === true,
  };
}

/**
 * Loads the run at `dir` for a command that deletes in it, refusing any
 * folder that is not one run this checkout created: the shared runs folder,
 * a repository's folder of runs, a run of another checkout, and a run.json
 * that names a folder other than `dir`. A refused run is not touched.
 */
export function ownRun(workspace: Workspace, dir: string): RunState {
  const runs = join(RUNS_DIR, workspace.name);
  if (canonical(dirname(dir)) !== canonical(runs))
    throw new Error(
      `${dir} is not one run of ${workspace.name}: pass the folder \`new\` printed, one level under ${runs}.`,
    );
  const file = stateFile(resolve(dir));
  if (!existsSync(file))
    throw new Error(
      `No run at ${dir}: run.json is missing. Create one with \`new\`.`,
    );
  const stored = object(parseJson(readFileSync(file, "utf8")), file);
  const recordedDir = str(stored, "dir");
  if (canonical(recordedDir) !== canonical(dir))
    throw new Error(
      `${file} records the folder ${recordedDir}, not ${dir}: it was copied from another run.`,
    );
  const repo = str(stored, "repo");
  if (canonical(repo) !== canonical(workspace.root))
    throw new Error(
      `${dir} was created by another checkout, ${repo}: only that checkout cleans it.`,
    );
  return loadRun(dir);
}

/** Writes `text` to `file` through a sibling temporary file and one rename, so a reader in another process sees the old content or the new, never part of it. */
export function writeWhole(file: string, text: string): void {
  const staging = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(staging, text);
    renameSync(staging, file);
  } finally {
    rmSync(staging, { force: true });
  }
}

/** Persists the run state; the processes a command's records file holds stay in that file only. */
export function saveRun(state: RunState): void {
  const commands = new Set(
    commandRecords(state.dir).map((record) => record.pid),
  );
  writeWhole(
    stateFile(state.dir),
    `${JSON.stringify({ ...state, processes: state.processes.filter((record) => !commands.has(record.pid)) }, null, 2)}\n`,
  );
}

/** A command's records file in the run folder: the command's PID, a random suffix that keeps a later command with a reused PID from overwriting it, and `.json`. */
const RECORDS_FILE = /^processes-(\d+)-[0-9a-f]+\.json$/;

/** This command's records file in each run it started processes in, and the records it holds. */
const ownRecords = new Map<
  string,
  { file: string; records: ProcessRecord[] }
>();

/**
 * The processes the commands of the run in `dir` recorded in their own
 * files: every command's, or only those of the command whose PID is
 * `command`. A file that does not hold a list of records records nothing,
 * and a temporary file a crashed command left is not read.
 */
export function commandRecords(dir: string, command?: number): ProcessRecord[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const match = RECORDS_FILE.exec(name);
    if (
      match === null ||
      (command !== undefined && Number(match[1]) !== command)
    )
      return [];
    try {
      return list(parseJson(readFileSync(join(dir, name), "utf8")), name).map(
        (entry) => {
          const record = object(entry, name);
          return { name: str(record, "name"), pid: num(record, "pid") };
        },
      );
    } catch {
      return [];
    }
  });
}

/**
 * Adds `add` to the processes the run records and drops the records of the
 * PIDs in `drop`, in `state` and in this command's records file, which
 * {@link loadRun} reads with run.json and every other command's file.
 * Several `journey` commands of one run may start and stop processes at
 * once; each writes only its own file, whole, so none can lose a record
 * another made, and none waits for another. The file goes once it records
 * nothing.
 */
export function recordProcesses(
  state: RunState,
  change: { add?: ProcessRecord[]; drop?: number[] },
): void {
  const apply = (records: ProcessRecord[]) => [
    ...records.filter((record) => !change.drop?.includes(record.pid)),
    ...(change.add ?? []),
  ];
  state.processes = apply(state.processes);
  const own = ownRecords.get(state.dir) ?? {
    file: join(
      state.dir,
      `processes-${process.pid}-${randomBytes(6).toString("hex")}.json`,
    ),
    records: [],
  };
  own.records = apply(own.records);
  ownRecords.set(state.dir, own);
  if (own.records.length === 0) rmSync(own.file, { force: true });
  else writeWhole(own.file, `${JSON.stringify(own.records)}\n`);
}

/** Allocates the folders of a new run under the system temp folder. */
export function allocateRun(
  workspace: Workspace,
  baseRef: string,
  title: string,
  all: boolean,
): RunState {
  const id = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`;
  const dir = join(RUNS_DIR, workspace.name, id);
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
    all,
    processes: [],
    containers: [],
    pack: "",
    manifestUrl: "",
    templateName: "",
    missingKeys: (workspace.config.saas?.env ?? []).filter(
      (key) => !process.env[key],
    ),
    timings: [],
  };
}

const INHERITED_PREFIXES = ["ANTELOPEJS_", "npm_", "PNPM_", "XDG_"];

/** The real path of `path`, resolved through its nearest existing ancestor when the path itself is gone. */
function canonical(path: string): string {
  const full = resolve(path);
  try {
    return realpathSync(full);
  } catch {
    const parent = dirname(full);
    return parent === full ? full : join(canonical(parent), basename(full));
  }
}

function isLeaseTmp(tmp: string | undefined, leaseDir: string): boolean {
  return !!tmp && canonical(tmp) === canonical(leaseTmpDir(leaseDir));
}

/**
 * The environment the operator would have outside `antelopejs-lease run`. A
 * lease is active only when `ANTELOPEJS_LEASE` and `ANTELOPEJS_LEASE_DIR` are
 * both non-empty. Under one, the lease's dev-stack variables and its own
 * `ANTELOPEJS_LEASE*` variables are dropped. `TMPDIR` is replaced only when
 * it is the lease's own tmp: by the value the lease recorded, or removed when
 * the operator had none, and kept as it is when the lease recorded nothing
 * (an older pack). A `TMPDIR` set for the command is honoured. Outside a
 * lease it is `process.env` unchanged, so the operator's own `PORT` or
 * `MONGO_URL` still counts.
 */
export function operatorEnv(): NodeJS.ProcessEnv {
  const leaseDir = process.env[LEASE_DIR];
  if (!process.env[LEASE_MARKER] || !leaseDir) return process.env;
  const dropped = new Set<string>([
    ...DEV_STACK_VARIABLES.filter((name) => name !== "TMPDIR"),
    LEASE_MARKER,
    LEASE_DIR,
    PARENT_TMPDIR,
  ]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !dropped.has(key)),
  );
  const recorded = process.env[PARENT_TMPDIR];
  if (recorded !== undefined && isLeaseTmp(env.TMPDIR, leaseDir)) {
    if (recorded) env.TMPDIR = recorded;
    else delete env.TMPDIR;
  }
  return env;
}

/**
 * The environment every driven command gets: the journey's HOME, CI=1, no
 * update check, no colors and the shared caches. Variables that could leak
 * the operator's own settings or the lease's dev stack into the run are
 * dropped; npm and pnpm settings in any case, since both also read their upper and lowercase spellings. `NPM_TOKEN` and other uppercase variables a `.npmrc` interpolates are kept. The config `env` can set any of them back on purpose.
 */
export function isolatedEnv(
  workspace: Workspace,
  home: string,
  extra: { [name: string]: string } = {},
): NodeJS.ProcessEnv {
  const kept = Object.entries(operatorEnv()).filter(
    ([key]) =>
      !INHERITED_PREFIXES.some((prefix) => key.startsWith(prefix)) &&
      !/^p?npm_config_/i.test(key),
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
    GIT_CONFIG_NOSYSTEM: "1",
    ...workspace.config.env,
    ...extra,
  };
}

/**
 * `path` with the repository's `node_modules/.bin` first, as `pnpm exec`
 * puts it, so setup commands, journeys and formal checks find the
 * repository's own bins whether the CLI was started through `pnpm exec` or
 * through `node_modules/.bin/antelopejs-verify`. A `path` that already lists
 * that folder, as `pnpm exec` from a package of a workspace does after the
 * package's own, is kept as it is, and so is an unset or empty one, which
 * leaves children the system's default search path.
 */
export function withLocalBins(
  root: string,
  path: string | undefined,
): string | undefined {
  if (!path) return path;
  const bins = resolve(root, "node_modules", ".bin");
  const listed = path
    .split(delimiter)
    .some((entry) => entry !== "" && resolve(root, entry) === bins);
  return listed ? path : `${bins}${delimiter}${path}`;
}
