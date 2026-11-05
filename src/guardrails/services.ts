import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isMap, isScalar, isSeq, parseDocument } from "yaml";

import { accepting } from "../lease/ports.ts";

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

function compose(root: string, args: string[]) {
  return spawnSync("docker", ["compose", "-f", COMPOSE_FILE, ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function failureText(
  args: string[],
  result: ReturnType<typeof compose>,
): string {
  const outcome = result.error
    ? result.error.message
    : `exited with ${result.signal ?? `status ${result.status}`}`;
  return `${result.stdout ?? ""}${result.stderr ?? ""}docker compose -f ${COMPOSE_FILE} ${args.join(" ")}: ${outcome}\n`;
}

function composeFailure(root: string, args: string[]): string {
  const result = compose(root, args);
  return result.status === 0 ? "" : failureText(args, result);
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
  const probe = composeFailure(root, ["version"]);
  if (!probe) return { kind: "start" };
  return {
    kind: "unavailable",
    output: `Docker Compose is not available, so the services in ${COMPOSE_FILE} cannot start and the tests that need them would hang. Start Docker, start the services yourself, or pass --no-services.\n${probe}`,
  };
}

/** Runs `docker compose up -d --wait` on the compose file; returns the failure output, empty on success. */
export function startServices(root: string): string {
  return composeFailure(root, ["up", "-d", "--wait"]);
}

/** Runs `docker compose down -v` on the compose file; returns the failure output, empty on success. */
export function stopServices(root: string): string {
  return composeFailure(root, ["down", "-v"]);
}
