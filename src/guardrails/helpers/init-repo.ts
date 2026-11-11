import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { checkRun, run } from "../../garden/helpers/builders.ts";
import { FakeApi } from "../../garden/helpers/fake-api.ts";
import { toolingVersions } from "../package.ts";
import { put } from "./test-repo.ts";

const NAME = "onboarded";

/** A git repository that was never onboarded: a package.json, one source file, no `.gitignore`, no workflow, nothing committed. */
export function bareRepo(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "antelope-init-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  put(
    root,
    "package.json",
    '{\n  "name": "onboarded",\n  "type": "module",\n  "packageManager": "pnpm@10.20.0"\n}\n',
  );
  put(root, "src/index.ts", "export const value = 1;\n");
  return root;
}

/** A JavaScript repository npm created, as cloud-commit-url-probe was before onboarding: no `packageManager`, no `test` or `typecheck` script, no tsconfig, npm's lockfile, and a `server.js` oxfmt would rewrap. */
export function bareJsRepo(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "antelope-init-js-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  put(
    root,
    "package.json",
    '{\n  "name": "probe",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": {\n    "start": "node server.js"\n  }\n}\n',
  );
  put(
    root,
    "package-lock.json",
    '{\n  "name": "probe",\n  "version": "1.0.0",\n  "lockfileVersion": 3,\n  "requires": true,\n  "packages": {\n    "": {\n      "name": "probe",\n      "version": "1.0.0"\n    }\n  }\n}\n',
  );
  put(
    root,
    "server.js",
    'const http = require("node:http");\nhttp.createServer((request, response) => { response.end("ok\\n"); }).listen(Number(process.env.PORT || 3000));\n',
  );
  return root;
}

/** Every file of the working tree that git does not ignore, by path: what the repository holds once it is committed and pushed. */
export function workingTree(root: string) {
  return Object.fromEntries(
    execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: root, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .filter((path) =>
        lstatSync(join(root, path), { throwIfNoEntry: false })?.isFile(),
      )
      .map((path) => [path, readFileSync(join(root, path), "utf8")]),
  );
}

/**
 * The garden's view of `root` once it is pushed to the default branch: its
 * files, the pack as the latest npm release, a first green `ci / checks` run, the
 * `pack=full` and `tier=N3` properties, and `delete_branch_on_merge` as given.
 */
export function pushedWorld(root: string, deletesBranchOnMerge: boolean) {
  return new FakeApi()
    .npmPackage("@antelopejs/tooling-configs", {
      name: "@antelopejs/tooling-configs",
      "dist-tags": { latest: toolingVersions().pack },
    })
    .route("/search/issues", {
      items: [
        { repository_url: `https://api.github.com/repos/AntelopeJS/${NAME}` },
      ],
    })
    .org([{ name: NAME, pack: "full", tier: "N3" }])
    .repo(NAME, workingTree(root))
    .ci(NAME, [run(1, "success", 2)], [checkRun("ci / checks", "success")])
    .route(`/repos/AntelopeJS/${NAME}/pulls`, [])
    .route(
      `/repos/AntelopeJS/${NAME}/commits?path=guardrails.ratchet.json&sha=main&per_page=30`,
      [],
    )
    .route(`/repos/AntelopeJS/${NAME}`, {
      delete_branch_on_merge: deletesBranchOnMerge,
    });
}
