import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after } from "node:test";

import type { JsonValue } from "../../garden/json.ts";
import { PACKAGE_ROOT } from "../../guardrails/helpers/test-repo.ts";
import { declaredSurface, diffSurface } from "../surface.ts";

const folders: string[] = [];

after(() => {
  for (const folder of folders)
    rmSync(folder, { recursive: true, force: true });
});

/** The declared surface of a package written from `files` under a fresh temporary folder, removed after the tests. */
export function surfaceOf(
  manifest: JsonValue,
  files: [string, string][],
  nodeTypes = false,
): Record<string, string> {
  const folder = mkdtempSync(join(tmpdir(), "surface-"));
  folders.push(folder);
  const all: [string, string][] = [
    ["package.json", JSON.stringify(manifest)],
    ...files,
  ];
  for (const [name, content] of all) {
    mkdirSync(dirname(join(folder, name)), { recursive: true });
    writeFileSync(join(folder, name), content);
  }
  if (nodeTypes) {
    mkdirSync(join(folder, "node_modules", "@types"), { recursive: true });
    symlinkSync(
      join(PACKAGE_ROOT, "node_modules", "@types", "node"),
      join(folder, "node_modules", "@types", "node"),
      "dir",
    );
  }
  return Object.fromEntries(declaredSurface(folder));
}

/** A package whose only types entry is `index.d.ts`. */
export const TYPES_MANIFEST = { name: "a", types: "index.d.ts" };

/** The paths `diffSurface` reports changed between two `index.d.ts` sources. */
export function changedPaths(before: string, after: string): string[] {
  const published = surfaceOf(TYPES_MANIFEST, [["index.d.ts", before]]);
  const head = surfaceOf(TYPES_MANIFEST, [["index.d.ts", after]]);
  const diff = diffSurface(
    new Map(Object.entries(published)),
    new Map(Object.entries(head)),
  );
  return diff.changed.map((entry) => entry.path);
}
