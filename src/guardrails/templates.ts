import { isMap, parseDocument } from "yaml";

import {
  execCommand,
  type PackageManager,
  type repositoryTools,
} from "./package.ts";

export const PRESET_CONFIGS = [
  {
    path: "oxlint.config.ts",
    legacy: [".oxlintrc.json"],
    specifier: "@antelopejs/tooling-configs/oxc/lint",
    content:
      'import { defineConfig } from "oxlint";\nimport { antelopePreset } from "@antelopejs/tooling-configs/oxc/lint";\n\nexport default defineConfig({\n  extends: [antelopePreset()],\n  options: { typeAware: true },\n});\n',
  },
  {
    path: "oxfmt.config.ts",
    legacy: [".oxfmtrc.json"],
    specifier: "@antelopejs/tooling-configs/oxc/fmt",
    content:
      'import { antelopeFmtPreset } from "@antelopejs/tooling-configs/oxc/fmt";\n\nexport default antelopeFmtPreset();\n',
  },
  {
    path: "knip.config.ts",
    legacy: ["knip.json", "knip.jsonc", ".knip.json"],
    specifier: "@antelopejs/tooling-configs/knip",
    content:
      'import { antelopeKnipConfig } from "@antelopejs/tooling-configs/knip";\n\nexport default antelopeKnipConfig();\n',
  },
] satisfies {
  path: keyof ReturnType<typeof repositoryTools>["presets"];
  legacy: string[];
  specifier: string;
  content: string;
}[];

export function presetConfig(
  current: string | undefined,
  preset: (typeof PRESET_CONFIGS)[number],
  tools: ReturnType<typeof repositoryTools>,
): string {
  const target = tools.presets[preset.path];
  const specifier = target.replaceAll("/", "\\/").replaceAll(".", "\\.");
  const imported = new RegExp(
    `(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*)["']${specifier}["']`,
  );
  if (current === undefined)
    return preset.content.replace(preset.specifier, target);
  if (imported.test(current)) return current;
  const importLine = preset.content
    .split("\n")
    .filter((line) => line.includes(preset.specifier))
    .join("\n")
    .replace(preset.specifier, target);
  throw new Error(
    `${preset.path} does not import its preset. Add \`${importLine}\` and extend that preset, then rerun antelopejs-sync. The file was not replaced.`,
  );
}

export function lefthook(
  current: string | undefined,
  manager: PackageManager,
  tools: ReturnType<typeof repositoryTools>,
  ratchet = true,
): string {
  const exec = execCommand(manager);
  const document = parseDocument(current ?? "{}\n");
  if (document.errors.length)
    throw new Error(
      `lefthook.yml: ${document.errors.map(({ message }) => message).join("; ")}`,
    );
  if (!isMap(document.contents))
    throw new Error(
      "lefthook.yml must contain a YAML mapping. Merge the guardrail hooks manually and rerun antelopejs-sync.",
    );
  if (current === undefined) document.contents.flow = false;
  const glob = "*.{js,mjs,cjs,jsx,ts,mts,cts,tsx,vue}";
  const hooks = {
    "pre-commit": {
      "antelopejs-format": {
        run: `${exec} oxfmt --no-error-on-unmatched-pattern {staged_files}`,
        stage_fixed: true,
      },
      "antelopejs-lint": {
        glob,
        run: `${exec} oxlint --no-error-on-unmatched-pattern {staged_files}`,
      },
      "antelopejs-size": {
        run: `${tools.hookPrefix}${tools.commands.size} --staged {staged_files}`,
      },
      "antelopejs-ratchet": {
        glob,
        run: `${tools.hookPrefix}${tools.commands.ratchet} --staged {staged_files}`,
      },
    },
    "pre-push": {
      "antelopejs-typecheck": { run: `${manager} run typecheck` },
    },
  };
  for (const [hook, commands] of Object.entries(hooks)) {
    for (const path of [[hook], [hook, "commands"]]) {
      if (!document.hasIn(path)) document.setIn(path, document.createNode({}));
      if (!isMap(document.getIn(path)))
        throw new Error(
          `lefthook.yml: ${path.join(".")} must be a mapping. Preserve the existing hook and merge its commands before rerunning antelopejs-sync.`,
        );
    }
    for (const [key, command] of Object.entries(commands))
      document.setIn([hook, "commands", key], document.createNode(command));
  }
  if (!ratchet)
    document.deleteIn(["pre-commit", "commands", "antelopejs-ratchet"]);
  return document.toString({ lineWidth: 0 });
}

export const SETUP_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$BASH_SOURCE")/.."
export CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
major="$(tr -d 'v[:space:]' < .nvmrc)"
if [[ "$(node -p 'process.versions.node.split(".")[0]')" != "$major" ]]; then
  if command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env --shell bash)"
    fnm install "$major"
    fnm use "$major"
  else
    export NVM_DIR="\${NVM_DIR:-$HOME/.nvm}"
    if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
      git clone --quiet --depth 1 --branch v0.40.3 https://github.com/nvm-sh/nvm.git "$NVM_DIR"
    fi
    source "$NVM_DIR/nvm.sh" --no-use
    nvm install "$major"
    nvm use "$major"
  fi
fi
pin="$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).packageManager || "pnpm"')"
manager="\${pin%%@*}"
corepack enable
if [[ "$pin" == *@* ]]; then
  corepack prepare "$pin" --activate
fi
case "$manager" in
  pnpm) pnpm install --frozen-lockfile ;;
  yarn) YARN_ENABLE_IMMUTABLE_INSTALLS=true yarn install --frozen-lockfile ;;
  npm) npm ci ;;
  bun) bun install --frozen-lockfile ;;
  *) printf 'Unsupported package manager %s\\n' "$manager" >&2; exit 1 ;;
esac
`;
