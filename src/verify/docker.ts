import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ContainerRecord, RunState, Workspace } from "./workspace.ts";
import { saveRun } from "./workspace.ts";

const READY_TIMEOUT_MS = 90_000;

function docker(args: string[]) {
  const run = spawnSync("docker", args, { encoding: "utf8" });
  return {
    status: run.status,
    stdout: run.stdout ?? "",
    stderr: `${run.stderr ?? ""}${run.error ? `${run.error.message}\n` : ""}`,
  };
}

function record(
  folder: string,
  args: string[],
  result: ReturnType<typeof docker>,
): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "command.txt"), `docker ${args.join(" ")}\n`);
  writeFileSync(join(folder, "stdout.txt"), result.stdout);
  writeFileSync(join(folder, "stderr.txt"), result.stderr);
  writeFileSync(join(folder, "exit-code.txt"), `${result.status}\n`);
}

function publishedPort(container: string, port: number): number {
  const mapping = docker(["port", container, `${port}/tcp`]).stdout;
  const match = /127\.0\.0\.1:(\d+)/.exec(mapping);
  if (!match)
    throw new Error(`${container} does not publish ${port}: ${mapping}`);
  return Number(match[1]);
}

function waitReady(container: string, ready: string[], folder: string): void {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = docker(["exec", container, ...ready]);
  while (last.status !== 0 && Date.now() < deadline) {
    spawnSync("sleep", ["0.5"]);
    last = docker(["exec", container, ...ready]);
  }
  record(folder, ["exec", container, ...ready], last);
  if (last.status !== 0)
    throw new Error(
      `${container} was not ready within ${READY_TIMEOUT_MS} ms: ${last.stderr}`,
    );
}

/**
 * Starts every service of verify.config.ts in its own container, named
 * `<prefix>-<repo>-<service>-<run id>`, publishes its port on a free
 * loopback port chosen by Docker, and waits for its readiness command. Each
 * container is recorded before it is probed, so `clean` removes it even when
 * it never became ready.
 */
export function startServices(
  workspace: Workspace,
  state: RunState,
  prefix: string,
): void {
  for (const [service, definition] of Object.entries(
    workspace.config.services ?? {},
  )) {
    const name =
      `${prefix}-${workspace.name}-${service}-${state.id}`.toLowerCase();
    const env = Object.entries(definition.env ?? {}).flatMap(([key, value]) => [
      "-e",
      `${key}=${value}`,
    ]);
    const args = [
      "run",
      "-d",
      "--name",
      name,
      "-p",
      `127.0.0.1::${definition.port}`,
      ...env,
      definition.image,
    ];
    const folder = join(state.evidence, "services", service);
    const started = docker(args);
    record(join(folder, "01-run"), args, started);
    if (started.status !== 0)
      throw new Error(`docker ${args.join(" ")} failed: ${started.stderr}`);
    const container: ContainerRecord = {
      service,
      name,
      host: "127.0.0.1",
      port: 0,
    };
    state.containers.push(container);
    saveRun(state);
    container.port = publishedPort(name, definition.port);
    saveRun(state);
    waitReady(name, definition.ready, join(folder, "02-ready"));
  }
}

/** Whether a recorded container is running. */
export function containerRunning(name: string): boolean {
  return (
    docker(["inspect", "-f", "{{.State.Running}}", name]).stdout.trim() ===
    "true"
  );
}

/** Removes a container this run started, by its recorded name. */
export function removeContainer(name: string): boolean {
  return docker(["rm", "-f", "-v", name]).status === 0;
}
