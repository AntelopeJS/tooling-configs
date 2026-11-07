import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { runCommand } from "./run-command.ts";

const SKILLS_FOLDER = ".agents/skills";
const LAYER_PREFIX = "verify-";
const TSCONFIG = "tsconfig.json";

/** Folders of a layer that are not the layer's own code: verify builds its playground with the playground's own tsconfig. */
const NOT_LAYER_CODE = new Set(["node_modules", "dist"]);
const LAYER_PLAYGROUND = "playground";

/**
 * Options the generated config sets over the layer's: nothing is emitted or cached, so no `.tsbuildinfo` is written, and the
 * declaration checks of a file that is never emitted are not run.
 */
const NO_OUTPUT = {
  noEmit: true,
  incremental: false,
  composite: false,
  declaration: false,
  declarationMap: false,
  emitDeclarationOnly: false,
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
        [TSCONFIG, "verify.config.ts"].some((file) =>
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

/** The repository's own `tsc` entry, run with Node so no shell parses its path. */
function compilerOf(root: string): string | undefined {
  try {
    return createRequire(join(root, "package.json")).resolve(
      "typescript/bin/tsc",
    );
  } catch {
    return undefined;
  }
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
  const ts = (await import("typescript")).default;
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: () => undefined,
  });
  if (parsed === undefined) return `${layer}/${TSCONFIG}: could not read it.\n`;
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
 * lists those files, and turns off emit, incremental builds and declaration checks, so nothing is written in the repository
 * and no package is fetched. Returns the compiler output of the layers that fail, empty when all pass.
 */
export async function typecheckLayers(
  root: string,
  signal?: AbortSignal,
): Promise<string> {
  const layers = verifyLayers(root);
  if (layers.length === 0) return "";
  const compiler = compilerOf(root);
  if (compiler === undefined)
    return "TypeScript is not installed in the repository root: run the package manager's install first.\n";
  const outputs = await Promise.all(
    layers.map((layer) => typecheckLayer(root, compiler, layer, signal)),
  );
  return outputs.join("");
}
