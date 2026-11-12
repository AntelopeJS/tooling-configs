import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import ts from "@typescript/typescript6";

/** The `typescript` manifest fields read here: every TypeScript version exports `typescript/package.json`, including 7, whose `exports` map hides the rest. */
interface TypeScriptManifest {
  version?: string;
}

/** The major version of the `typescript` that `directory` resolves, the compiler its own `tsc` runs; undefined when none resolves. */
export function installedTypeScriptMajor(
  directory: string,
): number | undefined {
  let manifest: string;
  try {
    manifest = createRequire(join(directory, "package.json")).resolve(
      "typescript/package.json",
    );
  } catch {
    return undefined;
  }
  /* SAFETY: a resolved `typescript/package.json` is the TypeScript package manifest, which carries its `version`. */
  const { version } = JSON.parse(
    readFileSync(manifest, "utf8"),
  ) as TypeScriptManifest;
  const major = Number.parseInt(version ?? "", 10);
  return Number.isNaN(major) ? undefined : major;
}

/** The first `module` from which TypeScript 5 turns on `esModuleInterop` by default: `node16` through `nodenext`, and `preserve` above them. */
const FIRST_NODE_MODULE = ts.ModuleKind.Node16;

/** How TypeScript 5 resolves modules when the config sets no `moduleResolution`, by `module`. */
function typescript5Resolution(module: ts.ModuleKind): string {
  if (module === ts.ModuleKind.CommonJS) return "node10";
  if (module === ts.ModuleKind.Preserve) return "bundler";
  if (module === ts.ModuleKind.NodeNext) return "nodenext";
  if (module >= FIRST_NODE_MODULE) return "node16";
  return "classic";
}

/** The value TypeScript 5 gives each compiler option whose default TypeScript 6 changed, given the options a config sets. */
function typescript5Defaults(options: ts.CompilerOptions) {
  const target = options.target ?? ts.ScriptTarget.ES5;
  const module =
    options.module ??
    (target >= ts.ScriptTarget.ES2015
      ? ts.ModuleKind.ES2015
      : ts.ModuleKind.CommonJS);
  const moduleResolution = typescript5Resolution(module);
  const bundler =
    options.moduleResolution === undefined
      ? moduleResolution === "bundler"
      : options.moduleResolution === ts.ModuleResolutionKind.Bundler;
  const esModuleInterop =
    options.esModuleInterop ?? module >= FIRST_NODE_MODULE;
  return {
    strict: false,
    types: ["*"],
    noUncheckedSideEffectImports: false,
    target: "es5",
    module: module === ts.ModuleKind.CommonJS ? "commonjs" : "es2015",
    moduleResolution,
    esModuleInterop,
    allowSyntheticDefaultImports:
      esModuleInterop || module === ts.ModuleKind.System || bundler,
  };
}

/** The `compilerOptions`, as a tsconfig spells them, that make the pack's TypeScript 6 read a config as the `major` a package installs does: for TypeScript 5, its own default for each option TypeScript 6 changed and the config leaves unset, and `ignoreDeprecations: "6.0"`, so the options TypeScript 6 deprecated still compile as TypeScript 5 accepts them. Empty for TypeScript 6 and 7, which share these defaults, and for an unknown major, read as the newest. */
export function installedCompilerDefaults(
  options: ts.CompilerOptions,
  major: number | undefined,
) {
  if (major === undefined || major >= 6) return {};
  const unset = Object.entries(typescript5Defaults(options)).filter(
    ([key]) => options[key] === undefined,
  );
  return { ...Object.fromEntries(unset), ignoreDeprecations: "6.0" };
}

/** Options parsed by the pack's TypeScript 6 as the `major` a package installs reads them; see `installedCompilerDefaults`. */
export function asInstalledCompilerReads(
  options: ts.CompilerOptions,
  major: number | undefined,
): ts.CompilerOptions {
  return {
    ...options,
    ...ts.convertCompilerOptionsFromJson(
      installedCompilerDefaults(options, major),
      "",
    ).options,
  };
}
