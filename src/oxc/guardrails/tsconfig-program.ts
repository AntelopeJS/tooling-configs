import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

interface Project {
  files: ReadonlySet<string>;
  options: ts.CompilerOptions;
  references: readonly string[];
  /** The `@types` packages tsc loads because the config lists no `compilerOptions.types`; empty when it lists them. */
  automaticTypes: readonly string[];
}

const CONFIG_NAMES = ["tsconfig.json", "jsconfig.json"];

const HOST: ts.ParseConfigFileHost = {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: () => undefined,
};

const projects = new Map<string, Project | undefined>();

function configAbove(directory: string): string | undefined {
  for (let current = directory; ; current = dirname(current)) {
    const config = CONFIG_NAMES.map((name) => join(current, name)).find(
      (path) => existsSync(path),
    );
    if (config !== undefined) return config;
    if (dirname(current) === current) return undefined;
  }
}

/** The files `config` lists, its compiler options and the configs it references, parsed once per lint run. */
export function project(config: string): Project | undefined {
  if (projects.has(config)) return projects.get(config);
  const parsed = ts.getParsedCommandLineOfConfigFile(config, undefined, HOST);
  const result = parsed && {
    files: new Set(parsed.fileNames),
    options: parsed.options,
    references: (parsed.projectReferences ?? []).map((reference) =>
      ts.resolveProjectReferencePath(reference),
    ),
    automaticTypes:
      parsed.options.types === undefined
        ? ts.getAutomaticTypeDirectiveNames(parsed.options, ts.sys)
        : [],
  };
  projects.set(config, result);
  return result;
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
 * The `@types` packages tsc loads into `config`'s program only because it lists no
 * `compilerOptions.types`. oxlint-tsgolint runs TypeScript 7, where `types` defaults
 * to none, so its program loads none of them.
 */
export function automaticTypes(config: string): readonly string[] {
  return project(config)?.automaticTypes ?? [];
}
