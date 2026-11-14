import { existsSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, resolve } from "node:path";
import ts from "@typescript/typescript6";

import {
  asInstalledCompilerReads,
  installedTypeScriptMajor,
} from "../../guardrails/installed-typescript.ts";

interface Project {
  files: ReadonlySet<string>;
  options: ts.CompilerOptions;
  references: readonly string[];
  /** The `@types` packages the repository's own tsc loads because the config lists no `compilerOptions.types`: all of them on TypeScript 5, none on 6 and later; empty when it lists them. */
  automaticTypes: readonly string[];
  /** Whether the program loads `@types/node`, whose ambient modules declare the Node built-ins. */
  nodeTypes: boolean;
}

const CONFIG_NAMES = ["tsconfig.json", "jsconfig.json"];

const HOST: ts.ParseConfigFileHost = {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: () => undefined,
};

/** The extension a config's `include` globs match besides TypeScript's own, so a Vue component is a root file of its program. */
const VUE_EXTENSION: readonly ts.FileExtensionInfo[] = [
  {
    extension: ".vue",
    isMixedContent: true,
    scriptKind: ts.ScriptKind.Deferred,
  },
];

const projects = new Map<string, Project | undefined>();

const resolutionCaches = new Map<string, ts.ModuleResolutionCache>();

function configAbove(directory: string): string | undefined {
  for (let current = directory; ; current = dirname(current)) {
    const config = CONFIG_NAMES.map((name) => join(current, name)).find(
      (path) => existsSync(path),
    );
    if (config !== undefined) return config;
    if (dirname(current) === current) return undefined;
  }
}

/** The files `config` lists, its compiler options as the TypeScript its directory installs reads them, and the configs it references, parsed once per lint run. */
export function project(config: string): Project | undefined {
  if (projects.has(config)) return projects.get(config);
  const parsed = ts.getParsedCommandLineOfConfigFile(
    config,
    undefined,
    HOST,
    undefined,
    undefined,
    VUE_EXTENSION,
  );
  const result = parsed && read(parsed, dirname(config));
  projects.set(config, result);
  return result;
}

/** A parsed config as the project of the TypeScript `directory` installs. */
function read(parsed: ts.ParsedCommandLine, directory: string): Project {
  const options = asInstalledCompilerReads(
    parsed.options,
    installedTypeScriptMajor(directory),
  );
  return {
    files: new Set(parsed.fileNames),
    options,
    references: (parsed.projectReferences ?? []).map((reference) =>
      ts.resolveProjectReferencePath(reference),
    ),
    automaticTypes:
      parsed.options.types === undefined
        ? ts.getAutomaticTypeDirectiveNames(options, ts.sys)
        : [],
    nodeTypes: ts
      .getAutomaticTypeDirectiveNames(options, ts.sys)
      .includes("node"),
  };
}

/** The first config the nearest one or its references reach that lists `file`, skipping configs already visited. */
function listing(
  nearest: string,
  file: string,
  visited: Set<string>,
): string | undefined {
  const queue = [nearest];
  for (let config = queue.shift(); config; config = queue.shift()) {
    if (visited.has(config)) continue;
    visited.add(config);
    const parsed = project(config);
    if (parsed?.files.has(file)) return config;
    queue.push(...(parsed?.references ?? []));
  }
  return undefined;
}

/**
 * The tsconfig.json or jsconfig.json whose program type-aware lint gives `file`,
 * found as oxlint-tsgolint finds it: the nearest config, the configs it references,
 * then the same search from each config above. Undefined when none lists the file,
 * where tsgolint reads it in its inferred program.
 */
export function programConfig(file: string): string | undefined {
  const path = resolve(file).replaceAll("\\", "/");
  const visited = new Set<string>();
  let directory = dirname(path);
  for (;;) {
    const nearest = configAbove(directory);
    if (nearest === undefined) return undefined;
    const config = listing(nearest, path, visited);
    if (config !== undefined) return config;
    const parent = dirname(dirname(nearest));
    if (parent === dirname(nearest)) return undefined;
    directory = parent;
  }
}

/**
 * Whether `specifier` imported from `file` names a module under `config`'s compiler
 * options: a file, a package, an untyped package's JavaScript, or a Node built-in
 * when the program loads `@types/node`. Any other ambient `declare module` is not a
 * resolution; only the program sees it.
 */
export function resolves(
  config: string,
  specifier: string,
  file: string,
): boolean {
  const parsed = project(config);
  if (parsed === undefined || (parsed.nodeTypes && isBuiltin(specifier)))
    return true;
  let cache = resolutionCaches.get(config);
  if (cache === undefined) {
    cache = ts.createModuleResolutionCache(
      dirname(config),
      (name) => (ts.sys.useCaseSensitiveFileNames ? name : name.toLowerCase()),
      parsed.options,
    );
    resolutionCaches.set(config, cache);
  }
  return (
    ts.resolveModuleName(specifier, file, parsed.options, ts.sys, cache)
      .resolvedModule !== undefined
  );
}

/**
 * The `@types` packages tsc loads into `config`'s program only because it lists no
 * `compilerOptions.types`. oxlint-tsgolint runs TypeScript 7, where `types` defaults
 * to none, so its program loads none of them.
 */
export function automaticTypes(config: string): readonly string[] {
  return project(config)?.automaticTypes ?? [];
}
