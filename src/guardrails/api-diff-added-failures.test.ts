import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  INTERNAL,
  MARKED,
  wildcardRepo,
} from "./helpers/api-diff-added-repo.ts";
import { bin, commit, put } from "./helpers/test-repo.ts";

test("api-diff --allow-added still fails a changed entry under internal, an added entry outside the glob, and a removed entry", (t) => {
  const root = wildcardRepo(t);
  put(root, "src/internal/old.ts", "export const old = 'changed';\n");
  commit(root);
  const changed = bin(root, "api-diff", ["base", ...INTERNAL]);
  assert.equal(changed.status, 1, changed.stdout + changed.stderr);
  assert.match(changed.stdout, /\+export declare const old/);
  execFileSync("git", ["reset", "-q", "--hard", "base"], { cwd: root });
  put(root, "src/public.ts", MARKED);
  commit(root);
  const outside = bin(root, "api-diff", ["base", ...INTERNAL]);
  assert.equal(outside.status, 1, outside.stdout + outside.stderr);
  assert.match(outside.stdout, /new file mode/);
  execFileSync("git", ["reset", "-q", "--hard", "base"], { cwd: root });
  rmSync(join(root, "src/internal/old.ts"));
  commit(root);
  const removed = bin(root, "api-diff", ["base", ...INTERNAL]);
  assert.equal(removed.status, 1, removed.stdout + removed.stderr);
  assert.match(removed.stdout, /deleted file mode/);
});
