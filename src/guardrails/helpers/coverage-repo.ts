import type { TestContext } from "node:test";

import { syncRepository } from "../sync.ts";
import { put, testRepo } from "./test-repo.ts";

/** The errors `sync --check` reports for a repository with these scripts, extra package.json fields and files. */
export function findingsFor(
  t: TestContext,
  scripts: Record<string, string>,
  configs: Record<string, string> = {},
  manifest: {
    "release-it"?: { hooks: Record<string, string | string[]> };
  } = {},
): string[] {
  const root = testRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({
      name: "coverage-test",
      type: "module",
      packageManager: "pnpm@10.0.0",
      scripts,
      ...manifest,
    }),
  );
  for (const [path, content] of Object.entries(configs))
    put(root, path, content);
  return syncRepository(root, { check: true }).errors;
}
