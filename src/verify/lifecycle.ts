import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join, relative } from "node:path";

import {
  child,
  children,
  num,
  object,
  optStr,
  parseJson,
  str,
} from "../garden/json.ts";
import { containerRunning, removeContainer, startServices } from "./docker.ts";
import { installedPackage } from "./fixture.ts";
import { linkDependencies } from "./interface.ts";
import { killGroup, runRecorded } from "./record.ts";
import { seedSources, templateName } from "./sources.ts";
import type { CommandResult } from "./types.ts";
import {
  allocateRun,
  git,
  isolatedEnv,
  removeTree,
  RUNS_DIR,
  saveRun,
  type RunState,
  type Workspace,
} from "./workspace.ts";

/** One line of `doctor`: what was checked, whether it holds and what was seen. */
export interface DoctorLine {
  check: string;
  ok: boolean;
  detail: string;
}

/** The prefix of every container a run starts; `VERIFY_CONTAINER_PREFIX` overrides it. */
function containerPrefix(): string {
  return process.env.VERIFY_CONTAINER_PREFIX ?? "verify";
}

/** The `prepack` values that do nothing but run the package's build script. */
const BUILD_ONLY_PREPACKS = new Set([
  "pnpm run build",
  "pnpm build",
  "npm run build",
  "yarn build",
  "yarn run build",
]);

function script(workspace: Workspace, name: string): string | undefined {
  return optStr(child(workspace.manifest, "scripts"), name);
}

/** Whether `pnpm pack` builds the package itself, so a setup build before it would run the same build twice. */
function packBuilds(workspace: Workspace): boolean {
  const prepack = script(workspace, "prepack");
  return (
    workspace.kind === "interface" &&
    prepack !== undefined &&
    BUILD_ONLY_PREPACKS.has(prepack.trim())
  );
}

function setupCommands(workspace: Workspace): string[][] {
  if (workspace.config.setup) return workspace.config.setup;
  return script(workspace, "build") !== undefined &&
    workspace.kind !== "template" &&
    !packBuilds(workspace)
    ? [["pnpm", "run", "build"]]
    : [];
}

async function runSetup(workspace: Workspace, state: RunState): Promise<void> {
  const commands = setupCommands(workspace);
  for (const [index, [program, ...args]] of commands.entries()) {
    const folder = join(
      state.evidence,
      "setup",
      `${String(index + 1).padStart(2, "0")}-${program}`,
    );
    const result = await runRecorded(folder, {
      program,
      args,
      cwd: workspace.root,
      env: { ...process.env, ...workspace.config.env },
    });
    if (result.exitCode !== 0)
      throw new Error(
        `setup \`${result.command}\` exited ${result.exitCode}; see ${folder}`,
      );
  }
}

/** The last 300 characters of each non-empty stream of a command, since a tool may print its message on either. */
function outputTail(result: CommandResult): string {
  return [
    ["stdout", result.stdout],
    ["stderr", result.stderr],
  ]
    .filter(([, text]) => text.trim() !== "")
    .map(([name, text]) => `${name}: ${text.trim().slice(-300)}`)
    .join("\n");
}

async function packInterface(
  workspace: Workspace,
  state: RunState,
): Promise<string> {
  const folder = join(state.dir, "pack");
  mkdirSync(folder, { recursive: true });
  const env = isolatedEnv(workspace, join(state.dir, "home"));
  const packed = await runRecorded(join(state.evidence, "setup", "pack"), {
    program: "pnpm",
    args: ["pack", "--pack-destination", folder],
    cwd: workspace.root,
    env,
  });
  const tarball = readdirSync(folder).find((file) => file.endsWith(".tgz"));
  if (packed.exitCode !== 0 || tarball === undefined)
    throw new Error(
      `pnpm pack failed; see ${packed.folder}\n${outputTail(packed)}`,
    );
  const extract = await runRecorded(join(state.evidence, "setup", "extract"), {
    program: "tar",
    args: ["-xzf", join(folder, tarball), "-C", folder],
    cwd: folder,
    env,
  });
  if (extract.exitCode !== 0)
    throw new Error(`tar failed: ${extract.stderr.slice(-300)}`);
  const root = join(folder, "package");
  linkDependencies(root, workspace.root);
  return root;
}

/** How long a run may sit untouched before the next `new` deletes it. */
const RUN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function lastActivity(dir: string): number {
  const file = join(dir, "run.json");
  return statSync(existsSync(file) ? file : dir).mtimeMs;
}

/** What a stale run may still hold: the PIDs and container names it recorded. */
interface Leftovers {
  pids: number[];
  containers: string[];
}

/** The leftovers a run recorded; none when its run.json is missing or unreadable. */
function recorded(dir: string): Leftovers {
  try {
    const state = object(
      parseJson(readFileSync(join(dir, "run.json"), "utf8")),
      "run.json",
    );
    return {
      pids: children(state, "processes").map((entry) => num(entry, "pid")),
      containers: children(state, "containers").map((entry) =>
        str(entry, "name"),
      ),
    };
  } catch {
    return { pids: [], containers: [] };
  }
}

function entries(folder: string): string[] {
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(folder, entry.name));
  } catch {
    return [];
  }
}

function pruneRun(dir: string, now: number): void {
  try {
    if (now - lastActivity(dir) < RUN_TTL_MS) return;
    const { pids, containers } = recorded(dir);
    if (pids.some(alive)) return;
    for (const name of containers) removeContainer(name);
    removeTree(dir);
  } catch (error) {
    if (existsSync(dir))
      process.stderr.write(
        `could not prune ${dir}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
  }
}

/**
 * Deletes every run under the runs folder, of any repository, that nothing
 * touched for seven days and whose recorded processes are all gone, with the
 * containers it recorded. A run a command loaded since then, or one with a
 * live process, is still in progress and stays. A run it cannot delete is
 * reported on stderr and never stops the new run.
 */
function pruneRuns(): void {
  const now = Date.now();
  for (const repo of entries(RUNS_DIR))
    for (const dir of entries(repo)) pruneRun(dir, now);
}

/**
 * Creates an isolated run: runs the setup (the build by default), then
 * prepares what the kind drives. An interface is packed as npm would publish
 * it, a template is served from an offline manifest repository, and every
 * kind's backing `services` start in Docker on free ports.
 */
export async function createRun(
  workspace: Workspace,
  baseRef: string,
  title: string,
  all: boolean,
): Promise<RunState> {
  pruneRuns();
  const state = allocateRun(workspace, baseRef, title, all);
  saveRun(state);
  await runSetup(workspace, state);
  if (workspace.kind === "interface")
    state.pack = await packInterface(workspace, state);
  startServices(workspace, state, containerPrefix());
  if (workspace.kind === "template") {
    state.manifestUrl = seedSources(workspace, state);
    state.templateName = templateName(workspace);
  }
  saveRun(state);
  return state;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function newestUnder(folder: string): number {
  if (!existsSync(folder)) return 0;
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .reduce(
      (newest, entry) =>
        Math.max(newest, statSync(join(entry.parentPath, entry.name)).mtimeMs),
      0,
    );
}

function buildLine(workspace: Workspace): DoctorLine {
  const built = newestUnder(join(workspace.root, "dist"));
  const source = newestUnder(join(workspace.root, "src"));
  if (workspace.kind === "template" || source === 0)
    return { check: "build", ok: true, detail: "nothing to build" };
  return {
    check: "build is newer than src",
    ok: built >= source,
    detail:
      built >= source
        ? "dist is current"
        : "src changed after the build; create a new run",
  };
}

function serviceLines(state: RunState): DoctorLine[] {
  return state.containers.map((container) => ({
    check: `service ${container.service}`,
    ok: containerRunning(container.name),
    detail: `${container.name} on ${container.host}:${container.port}`,
  }));
}

function kindLines(workspace: Workspace, state: RunState): DoctorLine[] {
  if (workspace.kind === "interface")
    return [
      {
        check: "packed interface",
        ok: existsSync(join(state.pack, "package.json")),
        detail: state.pack,
      },
      ...serviceLines(state),
    ];
  if (workspace.kind === "template")
    return [
      {
        check: "offline manifest",
        ok: existsSync(join(state.dir, "sources", "interfaces.git")),
        detail: `${state.templateName} at ${state.manifestUrl}`,
      },
      ...serviceLines(state),
    ];
  const keys = {
    check: "provider sandbox keys",
    ok: state.missingKeys.length === 0,
    detail:
      state.missingKeys.length === 0
        ? "present or not needed"
        : `missing ${state.missingKeys.join(", ")}: every journey is not verified`,
  };
  return [keys, ...serviceLines(state)];
}

/** Read-only checks that answer whether a run is worth driving. */
export function doctor(workspace: Workspace, state: RunState): DoctorLine[] {
  const head = git(workspace.root, ["rev-parse", "HEAD"]);
  let core = "";
  try {
    core = relative(
      workspace.root,
      installedPackage(workspace.root, "@antelopejs/core"),
    );
  } catch (error) {
    core = error instanceof Error ? error.message : String(error);
  }
  return [
    {
      check: "HEAD unchanged since new",
      ok: head === state.headSha,
      detail:
        head === state.headSha
          ? head.slice(0, 7)
          : `new at ${state.headSha.slice(0, 7)}, HEAD is ${head.slice(0, 7)}`,
    },
    {
      check: "ajs from the repository's @antelopejs/core",
      ok: !core.includes(" "),
      detail: core,
    },
    buildLine(workspace),
    ...kindLines(workspace, state),
    ...state.processes.map((record) => ({
      check: `no leftover process ${record.name}`,
      ok: !alive(record.pid),
      detail: `pid ${record.pid}`,
    })),
  ];
}

/** Stops what the run started, by recorded PID and container name, and removes everything but the evidence and run.json. Returns what it could not remove. */
export function clean(state: RunState): string[] {
  const lines: string[] = [];
  for (const record of state.processes) killGroup(record.pid);
  for (const container of state.containers)
    if (!removeContainer(container.name))
      lines.push(`could not remove container ${container.name}`);
  state.processes = [];
  state.containers = [];
  saveRun(state);
  for (const entry of readdirSync(state.dir)) {
    if (entry === "evidence" || entry === "run.json") continue;
    removeTree(join(state.dir, entry));
  }
  return lines;
}
