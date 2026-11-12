import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bin, commit, linkOxlint, put, testRepo } from "./helpers/test-repo.ts";
import { TSGOLINT } from "../oxc/helpers/tsgolint.ts";
import {
  calls,
  FLOATING,
  typedRepo,
  writeCeiling,
} from "./helpers/typed-ratchet-repo.ts";

const ANY = "typescript/no-explicit-any";

test("an approved type-aware raise is counted with the generated types the real tree has", (t) => {
  const root = typedRepo(t);
  put(root, "new.ts", calls(2).replaceAll("../gen", "./gen"));
  writeCeiling(root, FLOATING, 3);
  stageAll(root);
  const result = bin(root, "ratchet", ["--staged", "new.ts"], {
    APPROVED_RAISES: `${FLOATING}=3`,
    OXLINT_TSGOLINT_PATH: TSGOLINT,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /holds 4 findings/);
});

test("an ignore file above TMPDIR does not hide a tracked file from the approved count", (t) => {
  const outer = mkdtempSync(join(tmpdir(), "antelope-above-"));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  put(outer, ".gitignore", "lib/\n");
  mkdirSync(join(outer, "tmp"));
  const root = testRepo(t);
  linkOxlint(root);
  put(
    root,
    ".oxlintrc.json",
    JSON.stringify({
      categories: { correctness: "off" },
      plugins: ["typescript"],
      rules: { [ANY]: "error" },
    }),
  );
  put(
    root,
    "lib/legacy.ts",
    "export const a: any = 1;\nexport const b: any = 2;\n",
  );
  writeCeiling(root, ANY, 2);
  commit(root);
  put(root, "new.ts", "export const c: any = 3;\nexport const d: any = 4;\n");
  writeCeiling(root, ANY, 3);
  stageAll(root);
  const result = bin(root, "ratchet", ["--staged", "new.ts"], {
    APPROVED_RAISES: `${ANY}=3`,
    TMPDIR: join(outer, "tmp"),
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /holds 4 findings/);
});

function stageAll(root: string): void {
  execFileSync("git", ["add", "-A"], { cwd: root });
}
