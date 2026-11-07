import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import type { StepRecord } from "./results.ts";

/** A longer line, counted in bytes, makes the step a product failure: no output of it can be read for an outage. */
const MAX_LINE_BYTES = 8 * 1024;

/** The tools whose error lines can say that a registry was unreachable. */
type Tool = "npm" | "pnpm" | "docker";

/** The command words, after the program, that fetch packages or images. */
const FETCHING = new Map<string, readonly (readonly string[])[]>([
  [
    "docker",
    [
      ["pull"],
      ["build"],
      ["run"],
      ["buildx", "build"],
      ["compose", "pull"],
      ["compose", "build"],
      ["compose", "up"],
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

/** An `npm error` or `npm ERR!` line that carries an error code such as `ENOTFOUND` or `E503`. */
const NPM_LINE = /^npm (?:error|ERR!) .*\bE(?:[A-Z]{3,}|\d{3}|RR_[A-Z0-9_]+)\b/;

/** Any line of an npm error block. */
const NPM_PREFIX = /^npm (?:error|ERR!) /;

/** A pnpm error line, which pnpm indents by one space. */
const PNPM_LINE = /^ ?ERR_PNPM_[A-Z0-9_]+\b/;

/** The Docker CLI, the Docker daemon, and every BuildKit `ERROR:` line. */
const DOCKER_LINE =
  /^(?:docker: |Error response from daemon: |(?:#\d+ )?ERROR: )/;

/** A product failure that is not one of the error forms. */
const PRODUCT_FAILURE = /\berror TS\d+\b|\bELIFECYCLE\b|^\s*(?:✖|✗|not ok)\b/;

/** How a connection to a host fails before any answer, in any letter case. */
const NETWORK_CAUSE =
  /\b(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ERR_SOCKET_TIMEOUT|socket hang up|no such host|server misbehaving|i\/o timeout|TLS handshake timeout|tls: handshake failure|context deadline exceeded|unexpected EOF|Temporary failure in name resolution|Client\.Timeout exceeded while awaiting headers|connection refused|network is unreachable)\b/i;

/** A registry answering 5xx or 429, as npm and pnpm name it in the error code. */
const NPM_STATUS = /\bE(?:5\d\d|429)\b/;

/** The Docker Hub rate limit, and a 5xx the Docker client got from a registry. */
const DOCKER_STATUS =
  /\btoomanyrequests\b|\bpull rate limit\b|received unexpected HTTP status: 5\d\d\b/i;

/** The pnpm error codes that name a registry answer or a network cause. */
const PNPM_STATUS = /^ ?ERR_PNPM_FETCH_(?:5\d\d|429)\b/;
const PNPM_CAUSE_CODE =
  /^ ?ERR_PNPM_(?:ECONNRESET|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN)\b/;
const PNPM_FETCH_FAIL = /^ ?ERR_PNPM_META_FETCH_FAIL\b/;

function hostPattern(alternatives: string): RegExp {
  return new RegExp(`^(?:${alternatives})\\.?$`, "i");
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

/** A host with its optional port, in a URL or after a network cause. */
const URL_HOST = String.raw`(\[[^\]\s]+\]|[^\s"/:?#\[\]]+)(?::(\d+))?`;

/**
 * The places where a line names the target of the failing request: the URL
 * after `GET`, `HEAD`, `POST`, `PUT`, `DELETE` or `request to`, the
 * `lookup <host>` and `dial tcp <host>:<port>` of the Docker client, and the
 * address after a network error code.
 */
const TARGETS = [
  new RegExp(
    String.raw`(?:\b(?:get|head|post|put|delete)\b(?: request)?(?: to)?|\brequest to)[ ]+"?https?://${URL_HOST}`,
    "gi",
  ),
  /\bdial tcp (\[[^\]\s]+\]|[\w.-]+):(\d+)/gi,
  /\blookup ([\w.-]+)/gi,
  /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET)\s+(\[[^\]\s]+\]|[\w-]+(?:\.[\w-]+)+)(?::(\d+))?/gi,
];

interface Target {
  host: string;
  port: string | undefined;
}

function targetsOf(text: string): Target[] {
  return TARGETS.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => ({
      host: (match[1] ?? "").toLowerCase(),
      port: match[2],
    })),
  );
}

function publicIPv4(host: string): boolean {
  const octets = host.split(".").map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const [a = 0, b = 0] = octets;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** Whether a target is a known registry of the tool, or a public IPv4 address, on port 80 or 443. */
function isRegistry(tool: Tool, target: Target): boolean {
  if (
    target.port !== undefined &&
    target.port !== "80" &&
    target.port !== "443"
  )
    return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(target.host))
    return publicIPv4(target.host);
  return (
    OCI_HOST.test(target.host) ||
    (tool === "docker" ? DOCKER_HOST : NPM_HOST).test(target.host)
  );
}

/** Whether the text names at least one request target and every one is a known registry of the tool. */
function targetsRegistry(tool: Tool, text: string): boolean {
  const targets = targetsOf(text);
  return (
    targets.length > 0 && targets.every((target) => isRegistry(tool, target))
  );
}

function formOf(line: string): Tool | null {
  if (NPM_LINE.test(line)) return "npm";
  if (PNPM_LINE.test(line)) return "pnpm";
  if (DOCKER_LINE.test(line)) return "docker";
  return null;
}

/** What a tool's error line or npm error block says: the last error-form line, and whether every error line of it is a registry outage. */
interface Verdict {
  line: string;
  outage: boolean;
}

function npmVerdict(block: readonly string[]): Verdict | null {
  const forms = block.filter((line) => NPM_LINE.test(line));
  const line = forms.at(-1);
  if (line === undefined) return null;
  return {
    line,
    outage:
      forms.every(
        (form) => NPM_STATUS.test(form) || NETWORK_CAUSE.test(form),
      ) && targetsRegistry("npm", block.join("\n")),
  };
}

function pnpmSignal(line: string): boolean {
  return (
    PNPM_STATUS.test(line) ||
    PNPM_CAUSE_CODE.test(line) ||
    (PNPM_FETCH_FAIL.test(line) && NETWORK_CAUSE.test(line))
  );
}

function lineVerdict(tool: "pnpm" | "docker", line: string): Verdict {
  const signal =
    tool === "pnpm"
      ? pnpmSignal(line)
      : DOCKER_STATUS.test(line) || NETWORK_CAUSE.test(line);
  return { line, outage: signal && targetsRegistry(tool, line) };
}

/** What a stream shows: `blocked` when anything in it speaks for the product, and the last error line that is a registry outage. */
interface Scan {
  blocked: boolean;
  outage: string | null;
}

const BLOCKED: Scan = { blocked: true, outage: null };

/** An error form that only indentation hides, such as npm output quoted by a product test, whose author cannot be told. */
function unattributable(line: string): boolean {
  return formOf(line.trim()) !== null && formOf(line) === null;
}

function scan(text: string): Scan {
  const lines: string[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    if (Buffer.byteLength(raw) > MAX_LINE_BYTES) return BLOCKED;
    lines.push(stripVTControlCharacters(raw));
  }
  let outage: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (PRODUCT_FAILURE.test(line) || unattributable(line)) return BLOCKED;
    let verdict: Verdict | null = null;
    if (NPM_PREFIX.test(line)) {
      let end = index;
      while (end < lines.length && NPM_PREFIX.test(lines[end] ?? "")) end += 1;
      verdict = npmVerdict(lines.slice(index, end));
      for (const inner of lines.slice(index + 1, end))
        if (PRODUCT_FAILURE.test(inner) || unattributable(inner))
          return BLOCKED;
      index = end - 1;
    } else {
      const tool = formOf(line);
      if (tool === "pnpm" || tool === "docker")
        verdict = lineVerdict(tool, line);
    }
    if (verdict === null) continue;
    if (!verdict.outage) return BLOCKED;
    outage = verdict.line;
  }
  return { blocked: false, outage };
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
 * when that step's command exited non-zero or was signalled. A registry error
 * in a step whose command succeeded says nothing, and a failing step before an
 * outage is a verdict on the product that the outage must not hide.
 *
 * The step's `command.txt` must run a program and subcommand that fetch
 * dependencies or images, after any `NAME=value` prefix and whatever the
 * program's path: `docker pull`, `docker build`, `docker buildx build`,
 * `docker compose pull`, `build` or `up`, `docker run`, `npm install`, `ci`,
 * `i`, `pack` or `view`, `pnpm install`, `i`, `add`, `fetch` or `update`, and
 * `ajs module install` or `ajs project init` (also run as `node` on a script
 * inside `@antelopejs/core`). The subcommand words must follow the program
 * directly, so a flag before them, or any other command such as `pnpm test`,
 * `pnpm run`, `sh -c` or `node`, stays FAIL.
 *
 * The error lines of both streams are then read. The error forms are an
 * `npm error` or `npm ERR!` line with an error code, a pnpm `ERR_PNPM_*` line
 * (after at most one leading space), a Docker CLI `docker: ...` or `Error
 * response from daemon: ...` line, and any BuildKit `ERROR: ...` line, each at
 * the start of the line once ANSI escapes are stripped. Every error-form line
 * of both streams must be a registry outage, so one other error line, such as
 * `ELIFECYCLE`, `failed to solve: process ... did not complete` or an
 * `ERR_PNPM_*` that is not a fetch failure, means FAIL. So do an `error TS`
 * line, an `ELIFECYCLE` word or a `✖` or `not ok` test line anywhere, an error
 * form that only indentation hides, such as npm output quoted by a test, and
 * a line over 8 KiB, counted in bytes.
 *
 * An npm error block is the run of consecutive `npm error` lines, and its
 * lines count together. A line or block is an outage when it carries a
 * signal and every request target it names is a known registry. The signal is
 * a registry answer of 5xx or 429 (`E5xx` or `E429` in an npm error code,
 * `ERR_PNPM_FETCH_5xx` or `ERR_PNPM_FETCH_429`, `toomanyrequests`, a pull rate
 * limit or `received unexpected HTTP status: 5xx` in a Docker line), or one of
 * these network causes, in any letter case: `ENOTFOUND`, `EAI_AGAIN`,
 * `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `ERR_SOCKET_TIMEOUT`, `socket hang
 * up`, `no such host`, `server misbehaving`, `i/o timeout`, `TLS handshake
 * timeout`, `tls: handshake failure`, `context deadline exceeded`, `unexpected
 * EOF`, `Temporary failure in name resolution`, `Client.Timeout exceeded while
 * awaiting headers`, `connection refused` and `network is unreachable`. For
 * pnpm the signal is `ERR_PNPM_FETCH_5xx`, `ERR_PNPM_FETCH_429`,
 * `ERR_PNPM_ECONNRESET`, `ENOTFOUND`, `ETIMEDOUT`, `ECONNREFUSED` or
 * `EAI_AGAIN`, or `ERR_PNPM_META_FETCH_FAIL` with a network cause.
 *
 * The request targets are the URL after `GET`, `HEAD`, `POST`, `PUT`,
 * `DELETE` or `request to`, the host after `lookup`, the host before the port
 * after `dial tcp`, and the address after a network error code. A line that
 * names no target, such as a 5xx without a URL, is not an outage, and a host
 * that merely appears elsewhere on the line is ignored. Every target must be
 * on port 80 or 443 if it has a port, and either a known registry or a
 * public IPv4 address, so a loopback, private or link-local address, an IPv6
 * address, `localhost` and any host outside the lists stay FAIL. The known
 * hosts are `registry.npmjs.org`, `registry.yarnpkg.com` and
 * `registry.npmmirror.com` for npm and pnpm, `registry-1.docker.io`,
 * `docker.io`, `auth.docker.io`, `index.docker.io`,
 * `production.cloudflare.docker.com` and `*.r2.cloudflarestorage.com` for
 * Docker, and `ghcr.io`, `quay.io`, `gcr.io` and `<label>.gcr.io`,
 * `*.pkg.dev`, `public.ecr.aws` and `*.dkr.ecr.*.amazonaws.com` for all
 * three.
 *
 * A 404 or `manifest unknown`, a retry or warning line and any line that
 * merely mentions a registry or a timeout stay the product's failure.
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
    if (!exitedNonZero(folder) || !fetchesDependencies(folder)) return null;
    const scans = streamsOf(folder).map(scan);
    if (scans.some((entry) => entry.blocked)) return null;
    const line = scans.find((entry) => entry.outage !== null)?.outage;
    if (line === undefined || line === null) return null;
    return `step ${step.name} could not reach a container or package registry, an outage outside the code under test: ${line.trim().slice(0, 300)}`;
  } catch {
    return null;
  }
}
