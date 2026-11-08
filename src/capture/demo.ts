import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { parse, stringify } from "yaml";

import {
  child,
  flag,
  object,
  optStr,
  parseJson,
  strings,
  type JsonObject,
} from "../garden/json.ts";

/** The instant the demo and the browser treat as now: 2026-06-15 09:00 UTC, which is 10:00 in Brussels. */
export const DEMO_NOW = "2026-06-15T09:00:00Z";

const USAGE =
  "Usage: antelopejs-capture [--check] [--scene <id>] [--demo-ref <ref>]";

export interface CaptureArgs {
  check: boolean;
  scene: string | undefined;
  demoRef: string;
}

export function parseCaptureArgs(args: string[]): CaptureArgs {
  try {
    const { values } = parseArgs({
      args,
      allowPositionals: false,
      options: {
        check: { type: "boolean" },
        scene: { type: "string" },
        "demo-ref": { type: "string" },
      },
    });
    return {
      check: values.check ?? false,
      scene: values.scene,
      demoRef: values["demo-ref"] ?? "main",
    };
  } catch (error) {
    throw new Error(USAGE, { cause: error });
  }
}

interface DemoEnvironmentOptions {
  mongoUrl: string;
  database: string;
  port: number;
}

/** What the demo's capture start script reads, over the caller's own environment. */
export function demoEnvironment(
  options: DemoEnvironmentOptions,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TZ: "UTC",
    HELIO_NOW: DEMO_NOW,
    HELIO_SIMULATORS: "off",
    MONGODB_URL: options.mongoUrl,
    MONGODB_DATABASE: options.database,
    PORT: String(options.port),
    DMS_CLIENT_BASE_URL: `http://localhost:${options.port}`,
  };
}

/** A package of the capturing repository that the demo resolves to its working tree. */
export interface PublishedPackage {
  name: string;
  folder: string;
  manifest: JsonObject;
}

function publishedPackage(folder: string): PublishedPackage | undefined {
  try {
    const manifest = object(
      parseJson(readFileSync(join(folder, "package.json"), "utf8")),
      "package.json",
    );
    const name = optStr(manifest, "name");
    if (flag(manifest, "private") || name === undefined) return undefined;
    return { name, folder, manifest };
  } catch {
    return undefined;
  }
}

/** Every published package of `root`: the root itself, then each `packages/*` folder in name order, private ones left out. */
export function publishedPackages(root: string): PublishedPackage[] {
  const folders = [root];
  try {
    const entries = readdirSync(join(root, "packages"), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)))
      if (entry.isDirectory()) folders.push(join(root, "packages", entry.name));
  } catch {
    folders.length = 1;
  }
  return folders.flatMap((folder) => publishedPackage(folder) ?? []);
}

/**
 * The pnpm overrides that make a checkout of the demo run the capturing repository's own packages:
 * every published package of `root` mapped to its folder.
 */
export function packageOverrides(root: string): JsonObject {
  const overrides: JsonObject = {};
  for (const { name, folder } of publishedPackages(root))
    overrides[name] = `file:${folder}`;
  return overrides;
}

/**
 * The demo's `pnpm-workspace.yaml` with the overrides and the build allowances added. pnpm 11 reads
 * these settings only there, and pnpm 10.6 and later prefer it over `package.json`, so a setting the
 * demo keeps in `package.json` must be in the workspace file too.
 */
export function workspaceWithOverrides(
  text: string,
  overrides: JsonObject,
  builds: string[],
): string {
  const existing =
    text.trim() === "" ? {} : object(parse(text), "pnpm-workspace.yaml");
  const settings: JsonObject = {
    ...existing,
    overrides: { ...child(existing, "overrides"), ...overrides },
  };
  const allowed = [...strings(existing, "onlyBuiltDependencies"), ...builds];
  if (allowed.length) settings.onlyBuiltDependencies = [...new Set(allowed)];
  return stringify(settings);
}

export interface CheckoutSettings {
  pnpm: JsonObject;
  workspace: string;
}

/**
 * What a checkout of the demo is patched with: the demo's own `pnpm` field and workspace file, plus the
 * overrides for the packages of `root`, which win over a demo override of the same name. Both places get
 * the same settings, because the pnpm that runs the install decides which one it reads.
 */
export function checkoutSettings(
  pnpm: JsonObject,
  workspace: string,
  root: string,
): CheckoutSettings {
  const overrides = { ...child(pnpm, "overrides"), ...packageOverrides(root) };
  return {
    pnpm: { ...pnpm, overrides },
    workspace: workspaceWithOverrides(
      workspace,
      overrides,
      strings(pnpm, "onlyBuiltDependencies"),
    ),
  };
}
