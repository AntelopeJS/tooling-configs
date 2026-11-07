import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import type { StepRecord } from "./results.ts";

/** Longer lines are skipped: a registry error is one short line, and a megabyte of labels can overflow the regex stack. */
const MAX_LINE_CHARS = 8 * 1024;

/** The tools whose final error line can say that a registry was unreachable. */
type Tool = "npm" | "pnpm" | "docker";

/** An `npm error` or `npm ERR!` line that carries an error code such as `ENOTFOUND` or `E503`. */
const NPM_LINE = /^npm (?:error|ERR!) .*\bE(?:[A-Z]{3,}|\d{3}|RR_[A-Z0-9_]+)\b/;

/** A pnpm error line. */
const PNPM_LINE = /^ERR_PNPM_[A-Z0-9_]+\b/;

/** The Docker CLI, the Docker daemon, and the BuildKit error that ends a failed build. */
const DOCKER_LINE =
  /^(?:docker: |Error response from daemon: |(?:#\d+ )?ERROR: failed to (?:solve|resolve source metadata))/;

/** How a connection to a host fails before any answer. */
const NETWORK_CAUSE =
  /\b(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ERR_SOCKET_TIMEOUT|socket hang up|no such host|server misbehaving|i\/o timeout|TLS handshake timeout|tls: handshake failure|context deadline exceeded|unexpected EOF)\b/i;

/** A registry answering 5xx or 429, as npm and pnpm name it in the error code. */
const NPM_STATUS = /\bE(?:5\d\d|429)\b/;
const PNPM_STATUS = /\bERR_PNPM_FETCH_(?:5\d\d|429)\b/;

/** The Docker Hub rate limit, and a 5xx the Docker client got from a registry. */
const DOCKER_STATUS =
  /\btoomanyrequests\b|\bpull rate limit\b|received unexpected HTTP status: 5\d\d\b/i;

/** A whole host name: no label before it and no further label after it. */
const HOST_END = String.raw`(?![\w-]|\.\w)`;
const HOST_START = String.raw`(?<![\w.-])`;

function hostPattern(alternatives: string): RegExp {
  return new RegExp(`${HOST_START}(?:${alternatives})${HOST_END}`, "i");
}

/** The npm registries. */
const NPM_HOST = hostPattern(
  String.raw`registry\.npmjs\.org|registry\.yarnpkg\.com|registry\.npmmirror\.com`,
);

/** The Docker Hub hosts, which only a Docker line may name. */
const DOCKER_HOST = hostPattern(
  String.raw`(?:registry-1|auth|index)\.docker\.io|docker\.io|production\.cloudflare\.docker\.com|(?:[\w-]+\.)+r2\.cloudflarestorage\.com`,
);

/** The other public container registries, which any of the three tools may name. */
const OCI_HOST = hostPattern(
  String.raw`ghcr\.io|quay\.io|(?:[\w-]+\.)?gcr\.io|(?:[\w-]+\.)+pkg\.dev|public\.ecr\.aws|[\w-]+\.dkr\.ecr\.[\w-]+\.amazonaws\.com`,
);

/** The `ERR_PNPM_META_FETCH_FAIL` line and the host of the `GET https://...` it names. */
const PNPM_META_FETCH =
  /^ERR_PNPM_META_FETCH_FAIL\b.*?\bGET https?:\/\/([^\s/:?#]+)/;

function formOf(line: string): Tool | null {
  if (NPM_LINE.test(line)) return "npm";
  if (PNPM_LINE.test(line)) return "pnpm";
  if (DOCKER_LINE.test(line)) return "docker";
  return null;
}

function showsOutage(tool: Tool, line: string): boolean {
  if (tool === "npm")
    return (
      NPM_STATUS.test(line) ||
      (NETWORK_CAUSE.test(line) && (NPM_HOST.test(line) || OCI_HOST.test(line)))
    );
  if (tool === "pnpm") {
    if (PNPM_STATUS.test(line)) return true;
    const host = PNPM_META_FETCH.exec(line)?.[1];
    return (
      host !== undefined &&
      NETWORK_CAUSE.test(line) &&
      (NPM_HOST.test(host) || OCI_HOST.test(host))
    );
  }
  return (
    DOCKER_STATUS.test(line) ||
    (NETWORK_CAUSE.test(line) &&
      (DOCKER_HOST.test(line) || OCI_HOST.test(line)))
  );
}

/** The last error line a tool printed to a stream, and whether it names a registry outage. */
interface FinalError {
  outage: boolean;
  line: string;
}

function finalError(text: string): FinalError | null {
  let final: FinalError | null = null;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    if (raw.length > MAX_LINE_CHARS) continue;
    const line = stripVTControlCharacters(raw).trim();
    const tool = formOf(line);
    if (tool !== null) final = { outage: showsOutage(tool, line), line };
  }
  return final;
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

/**
 * Why a failed journey ended because a container or package registry could
 * not be reached, or `null` when the product, not the network, explains it.
 *
 * It is conservative: a missed outage stays a FAIL, and a product failure is
 * never softened. It reads only the first step with a failing check, and only
 * when that step's command exited non-zero or was signalled; a registry error
 * in a step whose command succeeded says nothing, and a failing step before an
 * outage is a verdict on the product that the outage must not hide.
 *
 * Only the final error a tool prints when it gives up counts, never a retry or
 * a warning. The error forms are an `npm error` or `npm ERR!` line with an
 * error code, a pnpm `ERR_PNPM_*` line, a Docker CLI `docker: ...` or `Error
 * response from daemon: ...` line, and the BuildKit `ERROR: failed to solve`
 * or `failed to resolve source metadata` line. Such a line names an outage
 * when it carries a registry answer of 5xx or 429 (`E5xx` or `E429` for npm,
 * `ERR_PNPM_FETCH_5xx` or `ERR_PNPM_FETCH_429` for pnpm, `toomanyrequests`, a
 * pull rate limit or `received unexpected HTTP status: 5xx` for Docker), or
 * one of these network causes together with a known registry host on that
 * line: `ENOTFOUND`, `EAI_AGAIN`, `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`,
 * `ERR_SOCKET_TIMEOUT`, `socket hang up`, `no such host`, `server misbehaving`,
 * `i/o timeout`, `TLS handshake timeout`, `tls: handshake failure`, `context
 * deadline exceeded` or `unexpected EOF`. The known hosts are
 * `registry.npmjs.org`, `registry.yarnpkg.com` and `registry.npmmirror.com`
 * for npm and pnpm lines, `registry-1.docker.io`, `docker.io`,
 * `auth.docker.io`, `index.docker.io`, `production.cloudflare.docker.com` and
 * `*.r2.cloudflarestorage.com` for Docker lines, and `ghcr.io`, `quay.io`,
 * `gcr.io`, `*.pkg.dev`, `public.ecr.aws` and `*.dkr.ecr.*.amazonaws.com` for
 * all three. For pnpm the host is the one in the `GET https://...` part of an
 * `ERR_PNPM_META_FETCH_FAIL` line.
 *
 * The decisive line must be the last error-form line of its stream, so a
 * product error printed after it means FAIL, and so does a last error line of
 * the other stream that is not an outage, since the two streams are saved
 * apart and their order is lost. ANSI escapes are stripped before matching
 * and lines over 8 KiB are skipped, so no output makes it throw. A 404 or
 * `manifest unknown`, a host outside the lists, and any line that merely
 * mentions a registry or a timeout stay the product's failure.
 */
export function registryFault(
  evidence: string,
  steps: readonly StepRecord[],
): string | null {
  try {
    const step = steps.find((entry) =>
      entry.checks.some((check) => !check.pass),
    );
    if (step === undefined) return null;
    const folder = join(evidence, step.folder);
    if (!exitedNonZero(folder)) return null;
    const finals = streamsOf(folder).map(finalError);
    if (finals.some((final) => final !== null && !final.outage)) return null;
    const line = finals.find((final) => final !== null)?.line;
    if (line === undefined) return null;
    return `step ${step.name} could not reach a container or package registry, an outage outside the code under test: ${line.slice(0, 300)}`;
  } catch {
    return null;
  }
}
