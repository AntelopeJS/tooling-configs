import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  isObject,
  isString,
  parseJson,
  type JsonObject,
} from "../garden/json.ts";
import { DRIVER_SOURCE, STUB_SOURCE } from "./fixture-modules.ts";
import type { RunState, Workspace } from "./workspace.ts";

/** A written fixture project and the environment its driver and stub read. */
export interface Fixture {
  project: string;
  env: { [name: string]: string };
}

function readPackage(folder: string): JsonObject {
  const value = parseJson(readFileSync(join(folder, "package.json"), "utf8"));
  return isObject(value) ? value : {};
}

/** The runtime export subpaths of a package: every `exports` key but `./package.json` and patterns, or `.` alone. */
function runtimeEntries(manifest: JsonObject): string[] {
  const exported = manifest.exports;
  if (
    exported === undefined ||
    exported === null ||
    isString(exported) ||
    !isObject(exported)
  )
    return ["."];
  const keys = Object.keys(exported).filter((key) => key.startsWith("."));
  if (keys.length === 0) return ["."];
  return keys.filter((key) => key !== "./package.json" && !key.includes("*"));
}

/** The interfaces a module declares in `antelopeJs.implements`. */
function implementedInterfaces(manifest: JsonObject): string[] {
  const antelope = manifest.antelopeJs;
  if (antelope === undefined || !isObject(antelope)) return [];
  const list = antelope.implements;
  return Array.isArray(list) ? list.filter(isString) : [];
}

/** The real folder of a dependency installed in the repository, or a clear error naming what to install. */
export function installedPackage(root: string, name: string): string {
  const folder = join(root, "node_modules", name);
  if (!existsSync(folder))
    throw new Error(
      `${name} is not installed in ${root}. Run the package manager's install first.`,
    );
  return realpathSync(folder);
}

function link(target: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, "dir");
}

function writeModule(
  folder: string,
  manifest: JsonObject,
  source: string,
  links: Map<string, string>,
): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  writeFileSync(join(folder, "index.js"), source);
  for (const [name, target] of links)
    link(target, join(folder, "node_modules", name));
}

function interfaceLinks(workspace: Workspace, state: RunState) {
  const core = installedPackage(workspace.root, "@antelopejs/interface-core");
  if (workspace.kind === "interface") {
    const name = String(workspace.manifest.name);
    return {
      links: new Map([
        [name, state.pack],
        ["@antelopejs/interface-core", core],
      ]),
      entries: { [name]: runtimeEntries(readPackage(state.pack)) },
    };
  }
  const links = new Map([["@antelopejs/interface-core", core]]);
  const entries: JsonObject = {};
  for (const name of implementedInterfaces(workspace.manifest)) {
    const folder = installedPackage(workspace.root, name);
    links.set(name, folder);
    entries[name] = runtimeEntries(readPackage(folder));
  }
  return { links, entries };
}

/**
 * Writes the fixture project of a journey: an `antelope.config.ts` loading
 * the driver module and, for the interface kind, the stub provider, or, for
 * the module kind, the module under verification as a `local` source. Every
 * interface the driver calls is linked to the copy the repository resolves,
 * so the project shares one copy per interface as core requires.
 */
export function writeFixture(
  workspace: Workspace,
  state: RunState,
  folder: string,
  moduleConfig: JsonObject,
): Fixture {
  const project = join(folder, "project");
  const { links, entries } = interfaceLinks(workspace, state);
  const modules: JsonObject = {};
  if (workspace.kind === "interface") {
    writeModule(
      join(project, "stub"),
      {
        name: "verify-stub",
        version: "1.0.0",
        main: "index.js",
        antelopeJs: { implements: Object.keys(entries) },
      },
      STUB_SOURCE,
      links,
    );
    modules["verify-stub"] = { source: { type: "local", path: "./stub" } };
  } else {
    modules[workspace.name] = {
      source: { type: "local", path: workspace.root },
      config: moduleConfig,
    };
  }
  writeModule(
    join(project, "driver"),
    { name: "verify-driver", version: "1.0.0", main: "index.js" },
    DRIVER_SOURCE,
    links,
  );
  modules["verify-driver"] = { source: { type: "local", path: "./driver" } };
  writeFileSync(
    join(project, "antelope.config.ts"),
    `export default ${JSON.stringify({ name: `verify-${workspace.name}`, modules }, null, 2)};\n`,
  );
  const config = join(workspace.skill, "verify.config.ts");
  return {
    project,
    env: {
      VERIFY_ENTRIES: JSON.stringify(entries),
      VERIFY_CALL_LOG: join(folder, "calls.jsonl"),
      VERIFY_SERVICES: JSON.stringify(
        state.containers.map(({ service, name, host, port }) => ({
          name: service,
          container: name,
          host,
          port,
        })),
      ),
      VERIFY_CONFIG: config,
    },
  };
}

/** The `ajs` entry of the `@antelopejs/core` the repository installs. */
export function ajsEntry(root: string): string {
  const folder = installedPackage(root, "@antelopejs/core");
  const manifest = parseJson(
    readFileSync(join(folder, "package.json"), "utf8"),
  );
  const bin =
    isObject(manifest) && manifest.bin !== undefined && isObject(manifest.bin)
      ? manifest.bin.ajs
      : undefined;
  if (bin === undefined || !isString(bin))
    throw new Error(`${folder} has no ajs bin`);
  return join(folder, bin);
}
