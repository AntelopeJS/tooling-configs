import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { put, read } from "./helpers/test-repo.ts";
import { parseManifest, toolingVersions } from "./package.ts";
import { alignWorkspaceMembers } from "./workspace-members.ts";

const PACK = "@antelopejs/tooling-configs";

type Catalog = Record<string, string>;

/** The fields of a Bun root package.json that list members and declare catalogs. */
interface BunWorkspaceFields {
  workspaces: string[] | { packages: string[]; catalog?: Catalog };
  catalogs?: Record<string, Catalog>;
}

/** A Bun workspace whose root package.json holds `fields` and the pack on `specs.root`, and whose `member` declares the pack as `specs.member`. */
function bunWorkspace(
  t: TestContext,
  fields: BunWorkspaceFields,
  specs: { root: string; member: string },
): string {
  const root = mkdtempSync(join(tmpdir(), "antelope-bun-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(
    root,
    "package.json",
    JSON.stringify({
      packageManager: "bun@1.4.4",
      ...fields,
      devDependencies: { [PACK]: specs.root },
    }),
  );
  put(
    root,
    "member/package.json",
    JSON.stringify({
      name: "member",
      devDependencies: { [PACK]: specs.member },
    }),
  );
  return root;
}

function align(root: string): ReturnType<typeof alignWorkspaceMembers> {
  return alignWorkspaceMembers(
    root,
    parseManifest(read(root, "package.json")),
    toolingVersions(),
  );
}

test("a member's plain pack range moves to the root's catalog: spec when the catalog is Bun's workspaces.catalog, where an aligner that reads only pnpm-workspace.yaml leaves the member on its own range", (t) => {
  const root = bunWorkspace(
    t,
    { workspaces: { packages: ["member"], catalog: { [PACK]: "^0.5.3" } } },
    { root: "catalog:", member: "^0.4.0" },
  );
  assert.deepEqual(align(root), {
    paths: ["member/package.json"],
    failures: [],
  });
  assert.equal(
    parseManifest(read(root, "member/package.json")).devDependencies?.[PACK],
    "catalog:",
  );
});

test("a member catalog: spec that Bun's top-level catalogs resolve to another range than the root's is named, where an aligner that reads only pnpm-workspace.yaml passes it silently", (t) => {
  const root = bunWorkspace(
    t,
    { workspaces: ["member"], catalogs: { legacy: { [PACK]: "^0.4.0" } } },
    { root: "^0.5.3", member: "catalog:legacy" },
  );
  const { failures } = align(root);
  assert.equal(failures.length, 1);
  assert.match(failures[0] ?? "", /member\/package\.json.*catalog:legacy/);
});

test("a member's plain pack range moves to the root's catalog: spec when pnpm-workspace.yaml builds the catalog with a YAML merge key, where an aligner that reads only the catalog's own keys leaves the member on its own range", (t) => {
  const root = bunWorkspace(
    t,
    { workspaces: ["member"] },
    { root: "catalog:", member: "^0.4.0" },
  );
  put(
    root,
    "pnpm-workspace.yaml",
    `packages:\n  - member\nbase: &base\n  "${PACK}": ^0.5.3\ncatalog:\n  <<: *base\n`,
  );
  assert.deepEqual(align(root), {
    paths: ["member/package.json"],
    failures: [],
  });
});

test("a merge key whose source is an alias to a list of maps still gives the catalog entry, where an aligner that expands only a literal list leaves the member on its own range", (t) => {
  const root = bunWorkspace(
    t,
    { workspaces: ["member"] },
    { root: "catalog:", member: "^0.4.0" },
  );
  put(
    root,
    "pnpm-workspace.yaml",
    `packages:\n  - member\na: &a\n  "${PACK}": ^0.5.3\nl: &l [*a]\ncatalog:\n  <<: *l\n`,
  );
  assert.deepEqual(align(root).paths, ["member/package.json"]);
});

test("a catalog that merges itself leaves the aligner to pnpm's own error, where an aligner that follows aliases without a visited set overflows the stack", (t) => {
  const root = bunWorkspace(
    t,
    { workspaces: ["member"] },
    { root: "catalog:", member: "^0.4.0" },
  );
  put(
    root,
    "pnpm-workspace.yaml",
    `packages:\n  - member\ncatalog: &a\n  <<: *a\n  "${PACK}": ^0.5.3\n`,
  );
  assert.deepEqual(align(root).paths, ["member/package.json"]);
});
