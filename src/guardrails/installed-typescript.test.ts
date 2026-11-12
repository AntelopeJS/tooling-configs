import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "@typescript/typescript6";
import ts5 from "typescript5";

import { asInstalledCompilerReads } from "./installed-typescript.ts";

/** Configs that leave some option TypeScript 6 changed the default of unset, as tsconfig `compilerOptions`. */
const CONFIGS = [
  {},
  { target: "es2020" },
  { module: "commonjs" },
  { module: "esnext" },
  { module: "node16" },
  { module: "node18" },
  { module: "node20" },
  { module: "nodenext" },
  { module: "nodenext", target: "es2020" },
  { module: "preserve" },
  { module: "system" },
  { module: "commonjs", target: "es2022" },
  { module: "esnext", moduleResolution: "bundler" },
  { module: "commonjs", esModuleInterop: true },
  { strict: true },
];

/** Source whose emit shows the target (async functions, class fields), the module format and the default-import interop. */
const SOURCE = `import value from "dependency";
export class Holder {
  field = value;
}
export const read = async () => new Holder().field;
`;

/** A script, not a module, whose emit shows whether the file is read in strict mode. */
const SCRIPT = "var shared = 1;\n";

/** The part of a TypeScript 5 or 6 module the emit below uses. */
interface Compiler {
  createProgram(
    rootNames: string[],
    options: ts.CompilerOptions,
  ): {
    emit(
      target: undefined,
      write: (name: string, text: string) => void,
    ): { emitSkipped: boolean };
  };
}

/** The JavaScript a program of `compiler` emits for `files` under `options`, as api-diff's emit runs it, by file name. */
function emitted(
  compiler: Compiler,
  files: string[],
  options: ts.CompilerOptions,
): Map<string, string> {
  const texts = new Map<string, string>();
  compiler
    .createProgram(files, { ...options, noEmit: false, declaration: false })
    .emit(undefined, (name, output) => {
      if (name.endsWith(".js")) texts.set(name, output);
    });
  return texts;
}

for (const config of CONFIGS)
  test(`TypeScript 6 reads ${JSON.stringify(config)} from a TypeScript 5 package with TypeScript 5's lib and emit, where an overlay with a fixed ES5 target, no interop default or strict mode on scripts differs`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "antelope-installed-ts-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const files = [join(directory, "index.ts"), join(directory, "script.ts")];
    writeFileSync(files[0], SOURCE);
    writeFileSync(files[1], SCRIPT);
    const real = ts5.convertCompilerOptionsFromJson(config, "/").options;
    const read = asInstalledCompilerReads(
      ts.convertCompilerOptionsFromJson(config, "/").options,
      5,
    );
    assert.equal(
      ts.getDefaultLibFileName(read),
      ts5.getDefaultLibFileName(real),
    );
    assert.deepEqual(emitted(ts, files, read), emitted(ts5, files, real));
  });
