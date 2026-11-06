import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Manifest } from "./package.ts";
import type { PlannedArtifact } from "./sync.ts";

/** The Renovate config file sync writes when a repository has none. */
const RENOVATE_PATH = "renovate.json";

/** The config files Renovate reads on GitHub, in its lookup order (`getConfigFileNames` in its `lib/config/app-strings.ts`), before the `renovate` key of `package.json`. */
export const RENOVATE_CONFIGS = [
  RENOVATE_PATH,
  "renovate.jsonc",
  "renovate.json5",
  ".github/renovate.json",
  ".github/renovate.jsonc",
  ".github/renovate.json5",
  ".renovaterc",
  ".renovaterc.json",
  ".renovaterc.jsonc",
  ".renovaterc.json5",
] as const;

const PRESET = "github>AntelopeJS/.github:renovate.json5";

/** Matches a config that extends the AntelopeJS shared Renovate preset. */
export const RENOVATE_PRESET = /github>AntelopeJS\/\.github(?::|\/)/;

const RENOVATE_JSON = `{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["${PRESET}"]
}
`;

/**
 * Writes `renovate.json` when the repository has no Renovate config, keeps an existing one byte for byte,
 * and fails one that does not extend the AntelopeJS preset, since rewriting it would drop the repository's settings.
 * `managed` is false for a project scaffolded from a template, whose Renovate setup is its own.
 */
export function renovateArtifacts(
  root: string,
  manifest: Manifest,
  managed: boolean,
): PlannedArtifact[] {
  if (!managed) return [];
  const file = RENOVATE_CONFIGS.find((path) => existsSync(join(root, path)));
  const path = file ?? "package.json";
  const text =
    file === undefined
      ? manifest.renovate === undefined || manifest.renovate === null
        ? undefined
        : JSON.stringify(manifest.renovate)
      : readFileSync(join(root, file), "utf8");
  if (text === undefined)
    return [
      {
        kind: "write",
        path: RENOVATE_PATH,
        content: RENOVATE_JSON,
        mode: undefined,
      },
    ];
  if (RENOVATE_PRESET.test(text)) return [{ kind: "unchanged", path }];
  return [
    {
      kind: "error",
      path,
      message: `${file ?? 'package.json "renovate"'}: extend "${PRESET}" in its extends, then rerun antelopejs-sync.`,
    },
  ];
}
