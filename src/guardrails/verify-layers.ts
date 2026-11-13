import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { parseManifest } from "./package.ts";
import { runCommand } from "./run-command.ts";

const SKILLS_FOLDER = ".agents/skills";
const LAYER_PREFIX = "verify-";
const TSCONFIG = "tsconfig.json";

/** Folders of a layer that are not the layer's own code: verify builds its playground with the playground's own tsconfig. */
const NOT_LAYER_CODE = new Set(["node_modules", "dist"]);
const LAYER_PLAYGROUND = "playground";

const VERIFY_CONFIG = "verify.config.ts";

/**
 * Options the generated config sets over the layer's: nothing is emitted, and each declaration or build-cache option the
 * layer may inherit is unset with `null`, so no `.tsbuildinfo` is written, no option is left needing `declaration` or
 * `composite`, and the declaration checks of files that are never emitted are not run.
 */
const NO_OUTPUT = {
  noEmit: true,
  declaration: null,
  composite: null,
  incremental: null,
  tsBuildInfoFile: null,
  declarationDir: null,
  declarationMap: null,
  emitDeclarationOnly: null,
  isolatedDeclarations: null,
};

/** The verify layers of a repository, relative to its root: each `.agents/skills/verify-*` folder that holds a `tsconfig.json` or a `verify.config.ts`. */
export function verifyLayers(root: string): string[] {
  const skills = join(root, SKILLS_FOLDER);
  if (!existsSync(skills)) return [];
  return readdirSync(skills, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith(LAYER_PREFIX) &&
        [TSCONFIG, VERIFY_CONFIG].some((file) =>
          existsSync(join(skills, entry.name, file)),
        ),
    )
    .map((entry) => `${SKILLS_FOLDER}/${entry.name}`)
    .sort();
}

/** Whether a file the layer's tsconfig includes is the layer's own code, not its playground, a dependency or a build output. */
function isLayerCode(layer: string, file: string): boolean {
  const segments = relative(layer, file).split(sep);
  return (
    segments[0] !== LAYER_PLAYGROUND &&
    !segments.some((segment) => NOT_LAYER_CODE.has(segment))
  );
}

/** The packages whose `tsc` a repository runs, in order: `typescript`, else `@typescript/native` when `typescript` is the TypeScript 6 API (`@typescript/typescript6`, whose only bin is `tsc6`) installed beside TypeScript 7 for tools that need that API. */
const COMPILER_PACKAGES = ["typescript", "@typescript/native"];

/**
 * The `bin.tsc` entry of the package `name` installed in `root`'s own `node_modules`, read from its `package.json`. Node's
 * resolution is not used: it falls back to `NODE_PATH`, where a package manager's bin shim lists the pack's own
 * dependencies, so a repository without TypeScript would be checked with the pack's.
 */
function binTsc(root: string, name: string): string | undefined {
  const manifestPath = join(root, "node_modules", name, "package.json");
  try {
    const tsc = parseManifest(readFileSync(manifestPath, "utf8")).bin?.tsc;
    return tsc === undefined ? undefined : join(dirname(manifestPath), tsc);
  } catch {
    return undefined;
  }
}

/** The repository's own `tsc` entry, run with Node so no shell parses its path. */
function compilerOf(root: string): string | undefined {
  for (const name of COMPILER_PACKAGES) {
    const tsc = binTsc(root, name);
    if (tsc !== undefined) return tsc;
  }
  return undefined;
}

async function typecheckLayer(
  root: string,
  compiler: string,
  layer: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const configPath = join(root, layer, TSCONFIG);
  if (!existsSync(configPath))
    return `${layer}: has a verify.config.ts and no tsconfig.json. Add a tsconfig.json that includes its TypeScript files; antelopejs-sync writes one for the shared kinds.\n`;
  const ts = (await import("@typescript/typescript6")).default;
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: () => undefined,
  });
  if (parsed === undefined) return `${layer}/${TSCONFIG}: could not read it.\n`;
  const verifyConfig = join(root, layer, VERIFY_CONFIG);
  if (
    existsSync(verifyConfig) &&
    !parsed.fileNames.some((file) => resolve(file) === verifyConfig)
  )
    return `${layer}/${TSCONFIG}: does not include ${VERIFY_CONFIG}, so it is never type-checked. Add it to the tsconfig's "include" or "files".\n`;
  const files = parsed.fileNames.filter((file) =>
    isLayerCode(join(root, layer), resolve(file)),
  );
  if (files.length === 0) return "";
  const folder = mkdtempSync(join(tmpdir(), "antelopejs-verify-types-"));
  try {
    const generated = join(folder, TSCONFIG);
    writeFileSync(
      generated,
      JSON.stringify({
        extends: configPath,
        compilerOptions: {
          ...NO_OUTPUT,
          typeRoots: ts.getEffectiveTypeRoots(parsed.options, ts.sys),
        },
        files,
        include: [],
      }),
    );
    const result = await runCommand(
      process.execPath,
      [compiler, "-p", generated, "--pretty", "false"],
      { cwd: root, env: { ...process.env, CI: "1" }, signal, shell: false },
    );
    return result.status === 0 ? "" : result.output;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * Type-checks the own code of each verify layer with the repository's own TypeScript. The files are those the layer's
 * `tsconfig.json` includes, minus its `playground` folder, which verify compiles with the playground's own config after
 * installing it, and any `node_modules` or `dist` folder. A config generated in the system temp folder extends the layer's,
 * lists those files, turns off emit and unsets the emit and build-cache options in `NO_OUTPUT`, so nothing is written in the
 * repository and no package is fetched. A layer whose `tsconfig.json` does not include its `verify.config.ts` fails. Returns the compiler output of the layers that fail, empty when all pass.
 */
export async function typecheckLayers(
  root: string,
  signal?: AbortSignal,
): Promise<string> {
  const layers = verifyLayers(root);
  if (layers.length === 0) return "";
  const compiler = compilerOf(root);
  if (compiler === undefined)
    return "TypeScript is not installed in the repository root: add typescript to its devDependencies and run the package manager's install.\n";
  const outputs = await Promise.all(
    layers.map((layer) => typecheckLayer(root, compiler, layer, signal)),
  );
  return outputs.join("");
}
