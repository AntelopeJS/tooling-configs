import { execFileSync } from "node:child_process";

import { apiRepo, commit, put } from "./test-repo.ts";

const BUILD = "tsc --noEmit false --composite false --declarationMap false";
export const INTERNAL = ["--allow-added", "**/internal/**"];

export function wildcardRepo(t: Parameters<typeof apiRepo>[0]): string {
  const root = apiRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({
      name: "public-api",
      type: "module",
      scripts: { build: BUILD },
      exports: { "./*": "./dist/*.js" },
    }),
  );
  put(root, "src/feature.ts", "export const feature: number = 1;\n");
  put(root, "src/internal/old.ts", "export const old = 1;\n");
  commit(root);
  execFileSync("git", ["tag", "base"], { cwd: root });
  return root;
}

export function addHelper(root: string, source: string): void {
  put(root, "src/internal/helper.ts", source);
  put(
    root,
    "src/feature.ts",
    "import { help } from './internal/helper.js';\nexport const feature: number = help();\n",
  );
  commit(root);
}

export const MARKED =
  "/** @internal */\nexport function help(): number { return 1; }\n";
