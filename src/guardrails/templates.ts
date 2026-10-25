import { execCommand, type PackageManager } from "./package.ts";

export const PRESET_CONFIGS = [
  {
    path: "oxlint.config.ts",
    specifier: "@antelopejs/tooling-configs/oxc/lint",
    content:
      'import { defineConfig } from "oxlint";\nimport { antelopePreset } from "@antelopejs/tooling-configs/oxc/lint";\n\nexport default defineConfig({\n  extends: [antelopePreset()],\n  options: { typeAware: true },\n});\n',
  },
  {
    path: "oxfmt.config.ts",
    specifier: "@antelopejs/tooling-configs/oxc/fmt",
    content:
      'import { antelopeFmtPreset } from "@antelopejs/tooling-configs/oxc/fmt";\n\nexport default antelopeFmtPreset();\n',
  },
  {
    path: "knip.config.ts",
    specifier: "@antelopejs/tooling-configs/knip",
    content:
      'import { antelopeKnipConfig } from "@antelopejs/tooling-configs/knip";\n\nexport default antelopeKnipConfig();\n',
  },
];

export function presetConfig(
  current: string | undefined,
  preset: (typeof PRESET_CONFIGS)[number],
): string {
  const specifier = preset.specifier
    .replaceAll("/", "\\/")
    .replaceAll(".", "\\.");
  const imported = new RegExp(
    `(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*)["']${specifier}["']`,
  );
  return current !== undefined && imported.test(current)
    ? current
    : preset.content;
}

export function lefthook(manager: PackageManager): string {
  const exec = execCommand(manager);
  return `pre-commit:
  commands:
    format:
      run: ${exec} oxfmt --no-error-on-unmatched-pattern {staged_files}
      stage_fixed: true
    lint:
      glob: "*.{js,mjs,cjs,jsx,ts,mts,cts,tsx,vue}"
      run: ${exec} oxlint --no-error-on-unmatched-pattern {staged_files}
    size:
      run: ${exec} antelopejs-check-size {staged_files}
pre-push:
  commands:
    typecheck:
      run: ${manager} run typecheck
`;
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
