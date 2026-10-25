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

/** A real temporary consumer, with only plugin specifiers redirected to the unbuilt source. */
export function lintProject() {
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
export default { extends: [preset] };
`,
  );
  return {
    root,
    write,
    remove: () => rmSync(root, { recursive: true, force: true }),
    run(measure: boolean | string = false) {
      const env = { ...process.env };
      delete env.ANTELOPEJS_RATCHET_MEASURE;
      if (measure !== false)
        env.ANTELOPEJS_RATCHET_MEASURE = measure === true ? "1" : measure;
      const result = spawnSync(process.execPath, [oxlint, "-f", "json"], {
        cwd: root,
        env,
        encoding: "utf8",
      });
      if (result.error !== undefined) throw result.error;
      if (result.stdout.length === 0) throw new Error(result.stderr);
      return { status: result.status, ...JSON.parse(result.stdout) };
    },
  };
}
