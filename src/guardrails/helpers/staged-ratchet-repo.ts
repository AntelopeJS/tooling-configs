import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { type TestContext } from "node:test";

import { formatCeilings } from "../ceilings.ts";
import {
  bin,
  commit,
  linkOxlint,
  PACKAGE_ROOT,
  put,
  testRepo,
} from "./test-repo.ts";

export const SAFETY = "anti-slop/require-safety-comment-for-type-assertion";
const UNKNOWN_RETURNS = "anti-slop/no-unknown-returns";

export const MOLLIE_5_PRELUDE =
  "interface Own {\n  id: string;\n}\ndeclare function readOwn(record: object): object | undefined;\ndeclare function ownOf(record: object): Own;\n";
export const MOLLIE_5_BASE = `${MOLLIE_5_PRELUDE}export function settle(mollie: object): Own {\n  const own = readOwn(mollie) as Own;\n  return own;\n}\n`;
export const MOLLIE_5_BRANCH = `${MOLLIE_5_PRELUDE}export function settle(mollie: object): Own {\n  const own = ownOf(mollie);\n  return own;\n}\n`;

export function stage(root: string, ...files: string[]): void {
  execFileSync("git", ["add", "-A", "--", ...files], { cwd: root });
}

export function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

export function baseRepo(
  t: TestContext,
  files: Record<string, string>,
): string {
  const root = testRepo(t);
  linkOxlint(root);
  put(
    root,
    ".oxlintrc.json",
    JSON.stringify({
      categories: { correctness: "off" },
      jsPlugins: [
        {
          name: "anti-slop",
          specifier: join(PACKAGE_ROOT, "src/oxc/anti-slop/index.ts"),
        },
      ],
      rules: { [SAFETY]: "error", [UNKNOWN_RETURNS]: "error" },
    }),
  );
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({
      rules: { [SAFETY]: 5, [UNKNOWN_RETURNS]: 5 },
      oversizeFiles: {},
    }),
  );
  for (const [file, content] of Object.entries(files)) put(root, file, content);
  commit(root);
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(
    root,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  );
  return root;
}

export function branchRepo(
  t: TestContext,
  file: string,
  base: string,
  branch: string,
): string {
  const root = baseRepo(t, { [file]: base });
  put(root, file, branch);
  commit(root);
  return root;
}

export function check(root: string, ...files: string[]) {
  return bin(root, "ratchet", ["--staged", ...files]);
}

export const CAST = (name: string) =>
  `export const ${name} = readOwn({}) as Own;\n`;
export const ANNOTATED = (name: string) =>
  `// SAFETY: readOwn always returns an Own here.\n${CAST(name)}`;
