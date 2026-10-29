import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { isObject } from "../garden/json.ts";
import { containerRunning, removeContainer, startServices } from "./docker.ts";
import { installedPackage } from "./fixture.ts";
import { linkDependencies } from "./interface.ts";
import { killGroup, runRecorded } from "./record.ts";
import { seedSources, templateName } from "./sources.ts";
import {
  allocateRun,
  git,
  isolatedEnv,
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

function setupCommands(workspace: Workspace): string[][] {
  if (workspace.config.setup) return workspace.config.setup;
  const scripts = workspace.manifest.scripts;
  const build =
    scripts !== undefined && isObject(scripts) && scripts.build !== undefined;
  return build && workspace.kind !== "template"
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
    throw new Error(`pnpm pack failed: ${packed.stderr.slice(-300)}`);
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

/**
 * Creates an isolated run: runs the setup (the build by default), then
 * prepares what the kind drives. An interface is packed as npm would publish
 * it, a module's backing services start in Docker on free ports, and a
 * template is served from an offline manifest repository.
 */
export async function createRun(
  workspace: Workspace,
  baseRef: string,
  title: string,
): Promise<RunState> {
  const state = allocateRun(workspace, baseRef, title);
  saveRun(state);
  await runSetup(workspace, state);
  if (workspace.kind === "interface")
    state.pack = await packInterface(workspace, state);
  if (workspace.kind === "module")
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

function kindLines(workspace: Workspace, state: RunState): DoctorLine[] {
  if (workspace.kind === "interface")
    return [
      {
        check: "packed interface",
        ok: existsSync(join(state.pack, "package.json")),
        detail: state.pack,
      },
    ];
  if (workspace.kind === "template")
    return [
      {
        check: "offline manifest",
        ok: existsSync(join(state.dir, "sources", "interfaces.git")),
        detail: `${state.templateName} at ${state.manifestUrl}`,
      },
    ];
  const keys = {
    check: "provider sandbox keys",
    ok: state.missingKeys.length === 0,
    detail:
      state.missingKeys.length === 0
        ? "present or not needed"
        : `missing ${state.missingKeys.join(", ")}: every journey is not verified`,
  };
  return [
    keys,
    ...state.containers.map((container) => ({
      check: `service ${container.service}`,
      ok: containerRunning(container.name),
      detail: `${container.name} on ${container.host}:${container.port}`,
    })),
  ];
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
    rmSync(join(state.dir, entry), { recursive: true, force: true });
  }
  return lines;
}
