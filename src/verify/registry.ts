import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { StepRecord } from "./results.ts";

/** A container or package registry host: the well-known public ones, and any `registry.<domain>` name with at least two more labels. */
const REGISTRY_HOST =
  /(?<![\w.-])(?:(?:[\w-]+\.)*(?:docker\.(?:io|com)|ghcr\.io|gcr\.io|quay\.io|pkg\.dev|ecr\.aws|mcr\.microsoft\.com|npmjs\.(?:org|com)|yarnpkg\.com|pkg\.github\.com)|registry(?:-\d+)?\.[\w-]+(?:\.[\w-]+)+)(?![\w-])/i;

/** The ways a connection to a host fails before any answer, from Docker, BuildKit, npm and pnpm. */
const NETWORK_FAILURE =
  /\b(?:no such host|server misbehaving|i\/o timeout|TLS handshake timeout|connection reset by peer|connection refused|network is unreachable|Temporary failure in name resolution|Client\.Timeout exceeded|request canceled while waiting for connection|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ESOCKETTIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b/i;

/** A 5xx answer with its status text, which a registry host sends when it is down. */
const SERVER_ERROR =
  /\b5\d\d (?:Bad Gateway|Service Unavailable|Gateway Time-?out|Internal Server Error)\b/i;

/** Lines that name an outage without a host: the Docker Hub rate limit, a 5xx the Docker client reports from a registry, a pnpm 5xx fetch. */
const OUTAGE_WITHOUT_HOST: readonly RegExp[] = [
  /\btoomanyrequests\b/i,
  /\bpull rate limit\b/i,
  /received unexpected HTTP status: 5\d\d\b/,
  /\bERR_PNPM_FETCH_5\d\d\b/,
];

function showsRegistryOutage(line: string): boolean {
  if (OUTAGE_WITHOUT_HOST.some((pattern) => pattern.test(line))) return true;
  if (/\bERR_PNPM_META_FETCH_FAIL\b/.test(line) && NETWORK_FAILURE.test(line))
    return true;
  return (
    REGISTRY_HOST.test(line) &&
    (NETWORK_FAILURE.test(line) || SERVER_ERROR.test(line))
  );
}

function outputOf(folder: string): string {
  return ["stdout.txt", "stderr.txt"]
    .map((name) => join(folder, name))
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
}

function exitedNonZero(folder: string): boolean {
  const file = join(folder, "exit-code.txt");
  return existsSync(file) && readFileSync(file, "utf8").trim() !== "0";
}

/**
 * Why a failed journey ended because a container or package registry could
 * not be reached, or `null` when the product, not the network, explains it.
 *
 * It reads only the first step with a failing check, and only when that step
 * ran a command that exited non-zero. A failure after the outage is its
 * consequence, but a failing step before it is a verdict on the product that
 * an outage later in the journey must not hide, and a registry error in a
 * step whose checks passed (a journey that expects the command to fail) says
 * nothing. A line counts only when it names a registry host together with a
 * connection failure or a 5xx answer, or states the Docker Hub rate limit, a
 * 5xx the Docker client got from a registry or a pnpm 5xx fetch. A 404 or
 * `manifest unknown` for an image or package that does not exist, and a
 * product error that merely mentions a timeout, name no registry and stay the
 * product's failure. The caller runs it on failed journeys only, so a journey
 * that passed is never turned into NOT VERIFIED.
 */
export function registryFault(
  evidence: string,
  steps: readonly StepRecord[],
): string | null {
  const step = steps.find((entry) => entry.checks.some((check) => !check.pass));
  if (step === undefined) return null;
  const folder = join(evidence, step.folder);
  if (!exitedNonZero(folder)) return null;
  const line = outputOf(folder).split("\n").find(showsRegistryOutage);
  if (line === undefined) return null;
  return `step ${step.name} could not reach a container or package registry, an outage outside the code under test: ${line.trim().slice(0, 300)}`;
}
