import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const lintModule = new URL("../lint.ts", import.meta.url).href;
const antiSlopPlugin = fileURLToPath(
  new URL("../anti-slop/index.ts", import.meta.url),
);
const guardrailsPlugin = fileURLToPath(
  new URL("../guardrails/index.ts", import.meta.url),
);
const oxlint = fileURLToPath(
  new URL("../bin/oxlint", import.meta.resolve("oxlint")),
);
const tsgolint = fileURLToPath(
  new URL(
    "bin/tsgolint.js",
    import.meta.resolve("oxlint-tsgolint/package.json"),
  ),
);
const nodeTypes = fileURLToPath(
  new URL("..", import.meta.resolve("@types/node/package.json")),
);

/** Type information for the temporary project: strict, with Node's types. */
const typeAwareTsconfig = JSON.stringify({
  compilerOptions: {
    strict: true,
    target: "es2022",
    module: "nodenext",
    typeRoots: [nodeTypes],
    types: ["node"],
  },
});

/**
 * A real temporary consumer, with only plugin specifiers redirected to the unbuilt source.
 * `typeAware` sets `options.typeAware` as a synced consumer does and writes a strict tsconfig.
 */
export function lintProject(typeAware = false) {
  const root = mkdtempSync(join(tmpdir(), "antelope-lint-"));
  function write(path: string, source: string) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, source);
  }
  write(
    "oxlint.config.ts",
    `
import { antelopePreset } from ${JSON.stringify(lintModule)};
const preset = antelopePreset();
for (const layer of preset.extends) {
  if (layer.jsPlugins) layer.jsPlugins = layer.jsPlugins.map((plugin) => ({
    ...plugin,
    specifier: plugin.name === "anti-slop" ? ${JSON.stringify(antiSlopPlugin)} : ${JSON.stringify(guardrailsPlugin)},
  }));
}
export default { extends: [preset]${typeAware ? ", options: { typeAware: true }" : ""} };
`,
  );
  if (typeAware) write("tsconfig.json", typeAwareTsconfig);
  return {
    root,
    write,
    remove: () => rmSync(root, { recursive: true, force: true }),
    run(measure: boolean | string = false, directory = root) {
      const env = { ...process.env };
      delete env.ANTELOPEJS_RATCHET_MEASURE;
      env.OXLINT_TSGOLINT_PATH = tsgolint;
      if (measure !== false)
        env.ANTELOPEJS_RATCHET_MEASURE = measure === true ? "1" : measure;
      const result = spawnSync(process.execPath, [oxlint, "-f", "json"], {
        cwd: directory,
        env,
        encoding: "utf8",
      });
      if (result.error !== undefined) throw result.error;
      if (result.stdout.length === 0) throw new Error(result.stderr);
      return { status: result.status, ...JSON.parse(result.stdout) };
    },
  };
}
