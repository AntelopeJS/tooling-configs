import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { isMap, isScalar, isSeq, parseDocument } from "yaml";

import { accepting } from "../lease/ports.ts";
import { runCommand } from "./run-command.ts";

/** The compose file the shared CI starts through its `services-compose-file` input, relative to the repository root. */
const COMPOSE_FILE = ".github/compose.yml";

/** What `antelopejs-checks` does about the compose services before its steps run. */
export type ServicesPlan =
  | { kind: "none" }
  | { kind: "start" }
  | { kind: "unavailable"; output: string };

function shortPort(text: string): number | undefined {
  const parts = text.replace(/\/\w+$/, "").split(":");
  return parts.length < 2 ? undefined : wholePort(parts.at(-2));
}

function wholePort(text: string | undefined): number | undefined {
  return text !== undefined && /^\d+$/.test(text) ? Number(text) : undefined;
}

/**
 * The host ports the compose file publishes, or `undefined` when a service publishes none or one this cannot read
 * (a range, an interpolation, a container-only port), since such a service cannot be probed.
 */
export function publishedPorts(text: string): number[] | undefined {
  const services = parseDocument(text).get("services");
  if (!isMap(services) || services.items.length === 0) return undefined;
  const ports: number[] = [];
  for (const { value } of services.items) {
    const entries = isMap(value) ? value.get("ports") : undefined;
    if (!isSeq(entries) || entries.items.length === 0) return undefined;
    for (const entry of entries.items) {
      const published = isMap(entry) ? entry.get("published") : undefined;
      const port = isScalar(entry)
        ? shortPort(String(entry.value))
        : wholePort(published === undefined ? undefined : String(published));
      if (port === undefined) return undefined;
      ports.push(port);
    }
  }
  return ports;
}

/**
 * The environment compose runs in. A project named by `COMPOSE_PROJECT_NAME` or by the compose file's own `name:` is
 * kept; otherwise the project is named after the repository root, since compose would name every repository's project
 * `github` after the compose file's directory and a run could adopt or remove another checkout's containers.
 */
function composeEnv(root: string): NodeJS.ProcessEnv {
  if (process.env.COMPOSE_PROJECT_NAME) return process.env;
  if (parseDocument(readFileSync(join(root, COMPOSE_FILE), "utf8")).has("name"))
    return process.env;
  const slug = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "");
  const digest = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return {
    ...process.env,
    COMPOSE_PROJECT_NAME: `${slug || "repo"}-${digest}`,
  };
}

async function compose(
  root: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ failure: string; stdout: string }> {
  const result = await runCommand(
    "docker",
    ["compose", "-f", COMPOSE_FILE, ...args],
    {
      cwd: root,
      env: composeEnv(root),
      signal,
    },
  );
  if (result.status === 0) return { failure: "", stdout: result.stdout };
  const outcome =
    result.status === null
      ? "did not finish"
      : `exited with status ${result.status}`;
  return {
    failure: `${result.output}docker compose -f ${COMPOSE_FILE} ${args.join(" ")}: ${outcome}\n`,
    stdout: result.stdout,
  };
}

/**
 * Decides whether the checks start the services of `.github/compose.yml`: not when the file is absent or every port
 * it publishes already accepts connections, and fail at once when Docker Compose cannot run, because the
 * tests that need those services would wait for them forever.
 */
export async function planServices(root: string): Promise<ServicesPlan> {
  if (!existsSync(join(root, COMPOSE_FILE))) return { kind: "none" };
  const ports = publishedPorts(readFileSync(join(root, COMPOSE_FILE), "utf8"));
  if (ports && (await Promise.all(ports.map(accepting))).every(Boolean))
    return { kind: "none" };
  const probe = await compose(root, ["version"]);
  if (!probe.failure) return { kind: "start" };
  return {
    kind: "unavailable",
    output: `Docker Compose is not available, so the services in ${COMPOSE_FILE} cannot start and the tests that need them would hang. Start Docker, start the services yourself, or pass --no-services.\n${probe.failure}`,
  };
}

/**
 * Runs `docker compose up -d --wait` on the compose file, stopping it when `signal` aborts. `failure` is empty on
 * success; `owned` is true when the project had no container before, so the run may remove it afterwards without
 * taking a stack the developer started.
 */
export async function startServices(
  root: string,
  signal?: AbortSignal,
): Promise<{ failure: string; owned: boolean }> {
  const before = await compose(root, ["ps", "--all", "--quiet"], signal);
  if (before.failure) return { failure: before.failure, owned: false };
  const owned = before.stdout.trim() === "";
  const up = await compose(root, ["up", "-d", "--wait"], signal);
  return { failure: up.failure, owned };
}

/** Runs `docker compose down -v` on the compose file; returns the failure output, empty on success. */
export async function stopServices(root: string): Promise<string> {
  return (await compose(root, ["down", "-v"])).failure;
}
