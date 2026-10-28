import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { isObject, isString, parseJson, type JsonValue } from "./json.ts";

/** A GitHub or npm answer that is not a success. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** What a scanning process can read besides the GitHub token: variable names and credential files. */
export interface SecretSurface {
  variables: string[];
  files: string[];
}

export interface RegistryFile {
  path: string;
  content: string;
}

export type WriteMethod = "PATCH" | "POST" | "PUT";

/** Everything the Gardener touches outside its own process. Tests replace it with recorded answers. */
export interface GardenApi {
  json(path: string): Promise<JsonValue>;
  pages(path: string, key?: string): Promise<JsonValue[]>;
  text(path: string): Promise<string>;
  bytes(path: string): Promise<Uint8Array>;
  send(method: WriteMethod, path: string, body: JsonValue): Promise<void>;
  npm(name: string): Promise<JsonValue | undefined>;
  contentLength(url: string): Promise<number | undefined>;
  registryDiffers(files: RegistryFile[]): Promise<boolean>;
  secrets(): SecretSurface;
  now(): Date;
}

const GITHUB = "https://api.github.com";
const NPM = "https://registry.npmjs.org";
const CREDENTIAL_NAME =
  /TOKEN|SECRET|PASSW|CREDENTIAL|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY/i;
const MINTED_TOKENS = new Set(["GH_TOKEN", "GITHUB_TOKEN"]);
const CREDENTIAL_FILES = [
  ".aws/credentials",
  ".netrc",
  ".pypirc",
  ".config/gcloud/application_default_credentials.json",
  ".kube/config",
  ".ssh/id_rsa",
  ".ssh/id_ed25519",
  ".ssh/id_ecdsa",
];
const MAX_ATTEMPTS = 4;

export function ghToken(): string {
  return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function nextLink(header: string | null): string | undefined {
  return header?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
}

function withPaging(path: string): string {
  return path.includes("per_page=")
    ? path
    : `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
}

function npmrcCarriesToken(home: string): boolean {
  const path = join(home, ".npmrc");
  return (
    existsSync(path) && /_auth(?:Token)?\s*=/.test(readFileSync(path, "utf8"))
  );
}

/** Reads variable names only, never values. */
export function readSecretSurface(
  names: string[],
  home: string,
): SecretSurface {
  const files = CREDENTIAL_FILES.filter((file) => existsSync(join(home, file)));
  if (npmrcCarriesToken(home)) files.push(".npmrc");
  return {
    variables: names
      .filter((name) => CREDENTIAL_NAME.test(name) && !MINTED_TOKENS.has(name))
      .sort(),
    files: files.sort(),
  };
}

/** Runs the released `antelopejs-registry --check` against committed manifests copied to a temporary directory. */
function registryCheck(files: RegistryFile[]): boolean {
  const directory = mkdtempSync(join(tmpdir(), "garden-registry-"));
  try {
    for (const file of files) {
      mkdirSync(dirname(join(directory, file.path)), { recursive: true });
      writeFileSync(join(directory, file.path), file.content);
    }
    const result = spawnSync(
      "npx",
      [
        "--yes",
        "--package",
        "@antelopejs/tooling-configs@latest",
        "antelopejs-registry",
        "--check",
        directory,
      ],
      { encoding: "utf8" },
    );
    if (result.error) throw result.error;
    return result.status !== 0;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Authenticates with the token `gh` is logged in with and with no other credential. */
export function createApi(token: string): GardenApi {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "antelopejs-garden",
  };

  async function request(
    url: string,
    init: {
      method?: string;
      headers?: { [name: string]: string };
      body?: string;
    },
  ): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(url, {
        ...init,
        headers: { ...headers, ...init.headers },
      });
      const retryAfter = Number(response.headers.get("retry-after") ?? 0);
      const limited =
        response.status === 429 ||
        (response.status === 403 && retryAfter > 0) ||
        response.status >= 502;
      if (!limited || attempt === MAX_ATTEMPTS) return response;
      await pause(Math.max(retryAfter, attempt) * 1000);
    }
  }

  async function get(path: string, accept?: string): Promise<Response> {
    const url = path.startsWith("http") ? path : `${GITHUB}${path}`;
    const response = await request(url, {
      headers: accept ? { Accept: accept } : {},
    });
    if (!response.ok)
      throw new ApiError(
        response.status,
        `GET ${path}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`,
      );
    return response;
  }

  return {
    async json(path) {
      return parseJson(await (await get(path)).text());
    },
    async pages(path, key) {
      const items: JsonValue[] = [];
      for (let url: string | undefined = `${GITHUB}${withPaging(path)}`; url;) {
        const response = await get(url);
        const body = parseJson(await response.text());
        const page = key === undefined || !isObject(body) ? body : body[key];
        if (Array.isArray(page)) items.push(...page);
        url = nextLink(response.headers.get("link"));
      }
      return items;
    },
    async text(path) {
      return (await get(path, "application/vnd.github.raw+json")).text();
    },
    async bytes(path) {
      return new Uint8Array(await (await get(path)).arrayBuffer());
    },
    async send(method, path, body) {
      const response = await request(`${GITHUB}${path}`, {
        method,
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok)
        throw new ApiError(
          response.status,
          `${method} ${path}: HTTP ${response.status}`,
        );
    },
    async npm(name) {
      const response = await fetch(`${NPM}/${name.replace("/", "%2F")}`);
      if (response.status === 404) return undefined;
      if (!response.ok)
        throw new ApiError(
          response.status,
          `npm ${name}: HTTP ${response.status}`,
        );
      return parseJson(await response.text());
    },
    async contentLength(url) {
      const response = await fetch(url, { method: "HEAD" });
      const length = response.headers.get("content-length");
      return response.ok && length !== null && isString(length)
        ? Number(length)
        : undefined;
    },
    async registryDiffers(files) {
      return registryCheck(files);
    },
    secrets() {
      return readSecretSurface(Object.keys(process.env), homedir());
    },
    now() {
      return new Date();
    },
  };
}
