import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { TestContext } from "node:test";

import {
  bin,
  commit,
  PACKAGE_ROOT,
  put,
  read,
  testRepo,
} from "../../guardrails/helpers/test-repo.ts";

/** The checks module a test config imports by absolute path, since a scratch repository installs nothing. */
export const CHECKS = join(PACKAGE_ROOT, "src/verify/checks.ts");

/** A complete door block with only `publish` applying to `package.json`. */
export const PUBLISH_DOORS = `{
    data: null,
    format: null,
    contract: null,
    outbound: null,
    exposure: null,
    publish: { globs: ["package.json"], funnels: [], containments: [], why: "the package name" },
  }`;

/** A module repository with an origin on GitHub, a synced verify-module skill and the given repo-owned files. */
export function verifyRepo(
  t: TestContext,
  files: Record<string, string>,
): string {
  const root = testRepo(t);
  execFileSync(
    "git",
    ["remote", "add", "origin", "https://github.com/acme/demo.git"],
    { cwd: root },
  );
  put(root, ".agents/skills/verify-module/SKILL.md", "synced\n");
  for (const [path, content] of Object.entries(files)) put(root, path, content);
  commit(root);
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], {
    cwd: root,
  });
  return root;
}

/** A feature file with its frontmatter lists and a body that names each journey. */
export function feature(
  covers: string[],
  journeys: string[],
  docs = ["README.md"],
): string {
  const list = (key: string, items: string[]) =>
    `${key}:\n${items.map((item) => `  - ${item}`).join("\n")}`;
  return `---\n${list("covers", covers)}\n${list("docs", docs)}\n${list("journeys", journeys)}\n---\n\n# Feature\n\n${journeys.map((id) => `- \`${id}\``).join("\n")}\n`;
}

/** Runs `antelopejs-verify` in `root` with runs under `tmp`. */
export function verify(
  root: string,
  tmp: string,
  args: string[],
  env: Record<string, string> = {},
) {
  return bin(root, "verify", args, { TMPDIR: tmp, ...env });
}

/** Creates a run and returns its folder, failing the test with the bin's output otherwise. */
export function newRun(
  root: string,
  tmp: string,
  env: Record<string, string> = {},
): string {
  const created = verify(root, tmp, ["new"], env);
  if (created.status !== 0) throw new Error(created.stderr || created.stdout);
  return created.stdout.trim();
}

/** Reads a JSON file of a run's evidence. */
export function evidence(run: string, path: string) {
  return JSON.parse(read(run, join("evidence", path)));
}
