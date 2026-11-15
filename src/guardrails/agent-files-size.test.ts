import assert from "node:assert/strict";
import test from "node:test";

import { MAX_FILE_BYTES } from "./ceilings.ts";
import { bin, commit, put, testRepo } from "./helpers/test-repo.ts";

/** Sized like dms `.agents/probes/backend-boundaries.cjs`, a probe the repository wrote and keeps at 65394 bytes. */
const probe = (extra = 0) => "x".repeat(MAX_FILE_BYTES + 1 + extra);

function agentRepo(t: Parameters<typeof testRepo>[0]): string {
  const root = testRepo(t);
  put(root, ".agents/probes/backend-boundaries.cjs", probe());
  put(root, ".agents/skills/verify-module/SKILL.md", probe());
  put(root, ".agents/skills/verify-module/package.json", probe());
  put(root, ".agents/skills/verify-module/tsconfig.json", probe());
  put(root, ".agents/probes/fixtures/large.ts", probe());
  commit(root);
  return root;
}

test("dms .agents/probes: the size guard fails an oversize repository-authored agent file, not the files sync writes", (t) => {
  const root = agentRepo(t);
  const result = bin(root, "check-size");
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /^\.agents\/probes\/backend-boundaries\.cjs: 20001 bytes, 1 bytes over the 20000-byte ceiling\./mu,
  );
  assert.doesNotMatch(result.stderr, /verify-module|fixtures/u);
});
