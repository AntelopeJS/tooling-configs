import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseManifest, toolingRoot } from "../package.ts";

const HOOKS = ["preinstall", "install", "postinstall"];

/** The install-time scripts the installed package `name` declares; the pack itself reads its own manifest. */
export function installScripts(name: string): string[] {
  const root = toolingRoot();
  const path =
    name === "@antelopejs/tooling-configs"
      ? join(root, "package.json")
      : join(root, "node_modules", name, "package.json");
  const scripts = parseManifest(readFileSync(path, "utf8")).scripts ?? {};
  return HOOKS.filter((hook) => hook in scripts);
}
