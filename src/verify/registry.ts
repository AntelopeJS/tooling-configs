import { lookup } from "node:dns";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { basename, join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import type { StepRecord } from "./results.ts";

/** A longer line, counted in bytes, is not read for a failing request. */
const MAX_LINE_BYTES = 8 * 1024;

/** How long each half of the probe, the DNS lookup and the TCP connect, may take before it counts as failed. */
const PROBE_TIMEOUT_MS = 3000;

/** The command words, after the program, that fetch packages or images. */
const FETCHING = new Map<string, readonly (readonly string[])[]>([
  [
    "docker",
    [
      ["pull"],
      ["build"],
      ["buildx", "build"],
      ["compose", "pull"],
      ["compose", "build"],
    ],
  ],
  ["npm", [["install"], ["ci"], ["i"], ["pack"], ["view"]]],
  ["pnpm", [["install"], ["i"], ["add"], ["fetch"], ["update"]]],
  [
    "ajs",
    [
      ["module", "install"],
      ["project", "init"],
    ],
  ],
]);

/** One shell word of a recorded command, quotes included. */
const SHELL_WORD = /(?:'[^']*'|"(?:\\.|[^"\\])*"|\\.|[^\s'"\\])+/g;
const SHELL_PIECE = /'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)/g;

/** A path inside the `@antelopejs/core` package, which `node` runs as `ajs`. */
const AJS_ENTRY = /(?:^|\/)@antelopejs\/core\//;

function shellWords(command: string): string[] {
  return (command.slice(0, 4096).match(SHELL_WORD) ?? [])
    .slice(0, 16)
    .map((word) =>
      word.replace(
        SHELL_PIECE,
        (_whole, single?: string, double?: string, escaped?: string) =>
          single ?? double?.replace(/\\(.)/g, "$1") ?? escaped ?? "",
      ),
    );
}

/** Whether a step's `command.txt` runs a program and subcommand that fetch dependencies or images. */
function fetchesDependencies(folder: string): boolean {
  const file = join(folder, "command.txt");
  if (!existsSync(file)) return false;
  const text = readFileSync(file, "utf8");
  const body = text.startsWith("cd ")
    ? text.slice(text.indexOf("\n") + 1)
    : text;
  const words = shellWords(body.split("\n")[0] ?? "");
  while (words.length > 0 && /^[A-Za-z_]\w*=/.test(words[0] ?? ""))
    words.shift();
  const first = words.shift();
  if (first === undefined) return false;
  let program = basename(first);
  if (program === "node" && AJS_ENTRY.test(words[0] ?? "")) {
    program = "ajs";
    words.shift();
  }
  return (FETCHING.get(program) ?? []).some((prefix) =>
    prefix.every((word, index) => words[index] === word),
  );
}

/** How a connection to a host fails before any answer, in any letter case. */
const NETWORK_CAUSE =
  /\b(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ERR_SOCKET_TIMEOUT|socket hang up|no such host|server misbehaving|i\/o timeout|TLS handshake timeout|context deadline exceeded|Temporary failure in name resolution|Client\.Timeout exceeded while awaiting headers|connection refused|network is unreachable)\b/i;

/** The public npm, Docker Hub and container registries a fetch may name: fixed names only, since a name the product picks can fail DNS for the product's own reasons. */
const REGISTRY_HOSTS = new Set([
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "registry.npmmirror.com",
  "registry-1.docker.io",
  "auth.docker.io",
  "index.docker.io",
  "docker.io",
  "production.cloudflare.docker.com",
  "docker-images-prod.6aa30f8b08e16409b46e0173d6de2f56.r2.cloudflarestorage.com",
  "ghcr.io",
  "quay.io",
  "gcr.io",
  "mirror.gcr.io",
  "public.ecr.aws",
]);

/** The npm summary lines that repeat the error code with no request, such as `npm error code ENOTFOUND`, also behind a BuildKit `#8 12.31` prefix or indentation. */
const NPM_SUMMARY =
  /(?:^|\s)npm (?:error|ERR!) (?:code|errno|syscall) [\w-]+\s*$/;

/** A host with its optional port, in a URL or after a network cause. */
const URL_HOST = String.raw`(\[[^\]\s]+\]|[^\s"/:?#\[\]]+)(?::(\d+))?`;

/** The address after a network error code; with no port, it is dropped when an earlier target on the line names the same host. */
const BARE_TARGET =
  /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET)\s+(\[[^\]\s]+\]|[\w-]+(?:\.[\w-]+)+)(?::(\d+))?/gi;

/**
 * The places where a line names the target of a request: the URL after
 * `GET`, `HEAD`, `POST`, `PUT`, `DELETE` or `request to`, the `lookup <host>`
 * and `dial tcp <host>:<port>` of the Docker client, and the address after a
 * network error code.
 */
const TARGETS = [
  new RegExp(
    String.raw`(?:\b(?:get|head|post|put|delete)\b(?: request)?(?: to)?|\brequest to)[ ]+"?https?://${URL_HOST}`,
    "gi",
  ),
  /\bdial tcp (\[[^\]\s]+\]|[\w.-]+):(\d+)/gi,
  /\blookup ([\w.-]+)/gi,
  BARE_TARGET,
];

/** The host and port a failing request was sent to. */
export interface Target {
  host: string;
  port: number;
}

/** Why a target did not answer a fresh DNS lookup and TCP connect, or `null` when it answered. */
export type Probe = (target: Target) => Promise<string | null>;

/** The targets of a line, or `null` when one of them is not a public registry on port 80 or 443. */
function registryTargets(line: string): Target[] | null {
  const targets: Target[] = [];
  for (const pattern of TARGETS)
    for (const match of line.matchAll(pattern)) {
      const host = (match[1] ?? "").toLowerCase().replace(/\.$/, "");
      const defaultPort = /http:\/\//i.test(match[0]) ? 80 : 443;
      const port = match[2] === undefined ? defaultPort : Number(match[2]);
      if (!REGISTRY_HOSTS.has(host) || (port !== 80 && port !== 443))
        return null;
      const named = targets.some((target) => target.host === host);
      if (pattern !== BARE_TARGET || match[2] !== undefined || !named)
        targets.push({ host, port });
    }
  return targets;
}

/** The registry targets of every line with a network cause, or `null` when a failing request went anywhere else or a line names no target. */
function failingTargets(texts: readonly string[]): Target[] | null {
  const found = new Map<string, Target>();
  for (const text of texts)
    for (const raw of text.split(/\r\n|\r|\n/)) {
      if (Buffer.byteLength(raw) > MAX_LINE_BYTES) continue;
      const line = stripVTControlCharacters(raw);
      if (!NETWORK_CAUSE.test(line)) continue;
      if (NPM_SUMMARY.test(line)) continue;
      const targets = registryTargets(line);
      if (targets === null || targets.length === 0) return null;
      for (const target of targets)
        found.set(`${target.host}:${target.port}`, target);
    }
  return [...found.values()];
}

function exitedNonZero(folder: string): boolean {
  const file = join(folder, "exit-code.txt");
  return existsSync(file) && readFileSync(file, "utf8").trim() !== "0";
}

function streamsOf(folder: string): string[] {
  return ["stdout.txt", "stderr.txt"]
    .map((name) => join(folder, name))
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, "utf8"));
}

/** What a fresh DNS lookup gave: the addresses, or why there were none. */
type Resolution =
  | { ok: true; addresses: string[] }
  | { ok: false; failure: string };

/** The addresses a host resolves to now, or why it did not resolve within the timeout. */
function resolve(host: string): Promise<Resolution> {
  return new Promise((settle) => {
    const timer = setTimeout(
      () =>
        settle({
          ok: false,
          failure: `no DNS answer within ${PROBE_TIMEOUT_MS} ms`,
        }),
      PROBE_TIMEOUT_MS,
    );
    lookup(host, { all: true }, (error, found) => {
      clearTimeout(timer);
      settle(
        error === null
          ? { ok: true, addresses: found.map((entry) => entry.address) }
          : { ok: false, failure: error.code ?? error.message },
      );
    });
  });
}

/** `null` once a TCP connection to the address opens, or why it did not within the timeout. */
function tcpConnect(address: string, port: number): Promise<string | null> {
  return new Promise((settle) => {
    const socket = connect({ host: address, port });
    socket.setTimeout(PROBE_TIMEOUT_MS, () => {
      socket.destroy();
      settle(`no TCP connect within ${PROBE_TIMEOUT_MS} ms`);
    });
    socket.once("connect", () => {
      socket.destroy();
      settle(null);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      settle(error.code ?? error.message);
    });
  });
}

/** Resolves the target's host now and opens a TCP connection to its port on every address it resolves to; one connect is enough to answer. */
export async function probeTarget({
  host,
  port,
}: Target): Promise<string | null> {
  const resolution = await resolve(host);
  if (!resolution.ok)
    return `DNS lookup of ${host} failed: ${resolution.failure}`;
  const failures = await Promise.all(
    resolution.addresses.map((address) => tcpConnect(address, port)),
  );
  if (failures.some((failure) => failure === null)) return null;
  const causes = [...new Set(failures)].join(", ");
  return `TCP connect to ${host} port ${port} failed on all ${failures.length} addresses: ${causes}`;
}

/**
 * Why a failed journey ended because a container or package registry could
 * not be reached, or `null` when the product, not the network, explains it.
 *
 * The output decides only which registry to ask; a live probe decides the
 * outage. A missed outage stays FAIL, and when the registry answers the
 * probe the failure is the product's, whatever the output says.
 *
 * It reads only the first step with a failing check, and only when that
 * step's command exited non-zero or was signalled. The step's `command.txt`
 * must run a program and subcommand that fetch dependencies or images, after
 * any `NAME=value` prefix and whatever the program's path: `docker pull`,
 * `docker build`, `docker buildx build`, `docker compose pull` or `build`,
 * `npm install`, `ci`, `i`, `pack` or `view`, `pnpm install`, `i`, `add`,
 * `fetch` or `update`, and `ajs module install` or `ajs project init` (also
 * run as `node` on a script inside `@antelopejs/core`). The subcommand words
 * must follow the program directly, so `pnpm test`, `pnpm run`, `sh -c`,
 * `node`, `docker run` and `docker exec` stay FAIL.
 *
 * The failing requests are the lines of both streams, ANSI escapes stripped
 * and lines over 8 KiB skipped, that carry a network cause such as
 * `ENOTFOUND`, `EAI_AGAIN`, `ECONNREFUSED`, `ETIMEDOUT`, `no such host`, `i/o
 * timeout` or `Temporary failure in name resolution`. Their targets are the
 * URL after `GET`, `HEAD`, `POST`, `PUT`, `DELETE` or `request to`, the host
 * after `lookup`, the host before the port after `dial tcp`, and the address
 * after a network error code, on port 443, or 80 for an `http://` URL, when
 * no port is named. Every line with a network cause must name a target, npm's
 * `code`, `errno` and `syscall` summary lines aside, and every target must be
 * one of these public registries on port 80 or 443: `registry.npmjs.org`,
 * `registry.yarnpkg.com`, `registry.npmmirror.com`, `registry-1.docker.io`,
 * `auth.docker.io`, `index.docker.io`, `docker.io`,
 * `production.cloudflare.docker.com`, Docker Hub's blob host on
 * `r2.cloudflarestorage.com`, `ghcr.io`, `quay.io`, `gcr.io`, `mirror.gcr.io`
 * and `public.ecr.aws`. Only fixed names count: a name the product picks, such as
 * an ECR account registry or a regional `pkg.dev` host, can fail DNS for the
 * product's own reasons, so it stays FAIL, and so do an address, a private
 * mirror and `localhost`.
 *
 * Each target then gets a fresh probe: a DNS lookup and a TCP connect to
 * every address it resolves to, each bounded to 3 s, and one connect that
 * succeeds is an answer. The journey is NOT VERIFIED only when every target fails
 * it, and the reason names the step and each probe's failure. A registry
 * that answered with a 5xx or 429 passes the probe, so it stays FAIL.
 */
export async function registryFault(
  evidence: string,
  steps: readonly StepRecord[],
  probe: Probe = probeTarget,
): Promise<string | null> {
  try {
    const step = steps.find((entry) =>
      entry.checks.some((check) => !check.pass),
    );
    if (step === undefined) return null;
    const folder = join(evidence, step.folder);
    if (!exitedNonZero(folder) || !fetchesDependencies(folder)) return null;
    const targets = failingTargets(streamsOf(folder));
    if (targets === null || targets.length === 0) return null;
    const failures = await Promise.all(targets.map(probe));
    if (failures.some((failure) => failure === null)) return null;
    return `step ${step.name} could not reach a container or package registry, which also fails a fresh probe now, an outage outside the code under test: ${failures.join("; ")}`;
  } catch {
    return null;
  }
}
