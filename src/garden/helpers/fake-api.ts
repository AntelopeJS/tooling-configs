import { readFileSync } from "node:fs";
import { deflateRawSync, crc32 } from "node:zlib";

import {
  ApiError,
  type GardenApi,
  type RegistryFile,
  type SecretSurface,
  type WriteMethod,
} from "../api.ts";
import { GardenContext } from "../context.ts";
import { isObject, parseJson, type JsonValue } from "../json.ts";

export const NOW = new Date("2026-10-28T20:00:00Z");

export interface WriteCall {
  method: WriteMethod;
  path: string;
  body: JsonValue;
}

export interface RepoSpec {
  name: string;
  pack?: string;
  tier?: string;
  language?: string;
  archived?: boolean;
  branch?: string;
}

export function fixture(name: string): JsonValue {
  return parseJson(
    readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"),
  );
}

function withoutQuery(path: string): string {
  return path.split("?")[0];
}

/** Serves recorded answers by path; an unknown path is a 404, exactly like GitHub's. */
export class FakeApi implements GardenApi {
  readonly writes: WriteCall[] = [];
  readonly requests: string[] = [];
  secretSurface: SecretSurface = { variables: [], files: [] };
  registryDrift = false;
  private readonly routes = new Map<string, JsonValue | ApiError>();
  private readonly texts = new Map<string, string>();
  private readonly archives = new Map<string, Uint8Array>();
  private readonly packages = new Map<string, JsonValue>();
  private readonly lengths = new Map<string, number>();

  route(path: string, body: JsonValue | ApiError): this {
    this.routes.set(path, body);
    return this;
  }

  file(path: string, content: string): this {
    this.texts.set(path, content);
    return this;
  }

  archive(path: string, content: Uint8Array): this {
    this.archives.set(path, content);
    return this;
  }

  npmPackage(name: string, body: JsonValue): this {
    this.packages.set(name, body);
    return this;
  }

  size(url: string, bytes: number): this {
    this.lengths.set(url, bytes);
    return this;
  }

  /** The organization listing and its `pack` and `tier` properties for the given repositories. */
  org(repos: RepoSpec[]): this {
    this.route(
      "/orgs/AntelopeJS/repos",
      repos.map((repo) => ({
        name: repo.name,
        archived: repo.archived === true,
        private: false,
        language: repo.language ?? "TypeScript",
        default_branch: "main",
      })),
    );
    this.route(
      "/orgs/AntelopeJS/properties/values",
      repos.map((repo) => ({
        repository_name: repo.name,
        properties: [
          { property_name: "pack", value: repo.pack ?? "full" },
          { property_name: "tier", value: repo.tier ?? "N1" },
        ],
      })),
    );
    for (const repo of repos)
      if (repo.branch === "next")
        this.route(`/repos/AntelopeJS/${repo.name}/branches/next`, {});
    return this;
  }

  /** A repository's default-branch tree and the contents of the given files. */
  repo(name: string, files: { [path: string]: string }): this {
    this.route(`/repos/AntelopeJS/${name}/git/trees/main`, {
      tree: Object.keys(files).map((path) => ({ path })),
    });
    for (const [path, content] of Object.entries(files))
      this.file(`/repos/AntelopeJS/${name}/contents/${path}`, content);
    return this;
  }

  /** Completed push runs of ci.yml, newest first, and the checks reported on the newest head. */
  ci(name: string, runs: JsonValue[], checks: JsonValue[] = []): this {
    this.route(`/repos/AntelopeJS/${name}/actions/workflows/ci.yml/runs`, {
      workflow_runs: runs,
    });
    const head = runs.find((entry) => isObject(entry));
    const sha = head !== undefined && isObject(head) ? head.head_sha : "main";
    this.route(`/repos/AntelopeJS/${name}/commits/${String(sha)}/check-runs`, {
      check_runs: checks,
    });
    this.route(`/repos/AntelopeJS/${name}/commits/main/check-runs`, {
      check_runs: checks,
    });
    return this;
  }

  context(): GardenContext {
    return new GardenContext(this);
  }

  private lookup(path: string): JsonValue {
    this.requests.push(path);
    const body = this.routes.get(path) ?? this.routes.get(withoutQuery(path));
    if (body === undefined) throw new ApiError(404, `GET ${path}: HTTP 404`);
    if (body instanceof ApiError) throw body;
    return body;
  }

  async json(path: string): Promise<JsonValue> {
    return this.lookup(path);
  }

  async pages(path: string, key?: string): Promise<JsonValue[]> {
    const body = this.lookup(path);
    const page = key !== undefined && isObject(body) ? body[key] : body;
    return Array.isArray(page) ? page : [];
  }

  async text(path: string): Promise<string> {
    this.requests.push(path);
    const text = this.texts.get(path) ?? this.texts.get(withoutQuery(path));
    if (text === undefined) throw new ApiError(404, `GET ${path}: HTTP 404`);
    return text;
  }

  async bytes(path: string): Promise<Uint8Array> {
    const content = this.archives.get(path);
    if (content === undefined) throw new ApiError(404, `GET ${path}: HTTP 404`);
    return content;
  }

  async send(
    method: WriteMethod,
    path: string,
    body: JsonValue,
  ): Promise<void> {
    this.writes.push({ method, path, body });
  }

  async npm(name: string): Promise<JsonValue | undefined> {
    return this.packages.get(name);
  }

  async contentLength(url: string): Promise<number | undefined> {
    return this.lengths.get(url);
  }

  async registryDiffers(_files: RegistryFile[]): Promise<boolean> {
    return this.registryDrift;
  }

  secrets(): SecretSurface {
    return this.secretSurface;
  }

  now(): Date {
    return NOW;
  }
}

/** A one-entry ZIP archive, as an Actions artifact download is. */
export function zip(name: string, content: string, deflate = true): Uint8Array {
  const raw = Buffer.from(content);
  const data = deflate ? deflateRawSync(raw) : raw;
  const method = deflate ? 8 : 0;
  const label = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc32(raw), 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(label.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc32(raw), 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(label.length, 28);
  const offset = local.length + label.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + label.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([local, label, data, central, label, end]);
}
