import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { formatCeilings, MAX_FILE_BYTES, readCeilings } from "./ceilings.ts";
import {
  bin,
  commit,
  linkOxlint,
  put,
  read,
  testRepo,
} from "./helpers/test-repo.ts";

/** Sized like dms `.agents/probes/backend-boundaries.cjs`, a probe the repository wrote and keeps at 65394 bytes. */
const probe = (extra = 0) => "x".repeat(MAX_FILE_BYTES + 1 + extra);

const RATCHET_BASE = {
  pack: "0.2.17",
  rules: { "eslint/max-params": 1 },
  oversizeFiles: {},
};

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
  assert.match(result.stderr, /antelopejs-ratchet --update/u);
  assert.doesNotMatch(result.stderr, /verify-module|fixtures/u);
});

test("ratchet --update records the oversize agent files once, for a repository recorded before they were counted, and only growth or new files fail after", (t) => {
  const root = agentRepo(t);
  linkOxlint(root);
  put(
    root,
    ".oxlintrc.json",
    JSON.stringify({
      plugins: ["eslint"],
      categories: { correctness: "off" },
      rules: { "eslint/max-params": "error" },
    }),
  );
  put(root, "guardrails.ratchet.json", formatCeilings(RATCHET_BASE));
  commit(root);
  const before = bin(root, "ratchet");
  assert.equal(before.status, 1);
  assert.match(
    before.stderr,
    /\.agents\/probes\/backend-boundaries\.cjs: 20001 bytes/,
  );
  const update = bin(root, "ratchet", ["--update"]);
  assert.equal(update.status, 0, update.stderr);
  assert.deepEqual(readCeilings(root), {
    pack: "0.2.18",
    rules: {},
    oversizeFiles: { ".agents/probes/backend-boundaries.cjs": 20_001 },
  });
  const recorded = read(root, "guardrails.ratchet.json");
  assert.equal(bin(root, "ratchet").status, 0);
  assert.equal(bin(root, "check-size").status, 0);
  const adopted = bin(root, "ratchet", ["--base", "HEAD"]);
  assert.equal(adopted.status, 0, adopted.stderr);
  put(
    root,
    "guardrails.ratchet.json",
    read(root, "guardrails.ratchet.json").replace(
      '"oversizeFiles": {',
      '"oversizeFiles": {\n    "src/big.ts": 30000,',
    ),
  );
  const raised = bin(root, "ratchet", ["--base", "HEAD"]);
  assert.equal(raised.status, 1);
  assert.match(raised.stderr, /adds an oversize allowance for src\/big\.ts\./);
  put(root, "guardrails.ratchet.json", recorded);
  put(root, ".agents/probes/backend-boundaries.cjs", probe(1));
  assert.equal(bin(root, "ratchet").status, 1);
  put(root, ".agents/probes/backend-boundaries.cjs", probe());
  put(root, ".agents/probes/second.cjs", probe());
  assert.equal(bin(root, "ratchet", ["--update"]).status, 1);
  assert.match(read(root, "guardrails.ratchet.json"), /"pack": "0\.2\.18"/);
});

test("verifier R1: an adopting branch records the oversize agent files that existed at the base and no new or grown one", (t) => {
  const root = testRepo(t);
  put(root, ".agents/probes/a.cjs", probe());
  linkOxlint(root);
  put(
    root,
    ".oxlintrc.json",
    JSON.stringify({
      plugins: ["eslint"],
      categories: { correctness: "off" },
      rules: { "eslint/max-params": "error" },
    }),
  );
  put(root, "guardrails.ratchet.json", formatCeilings(RATCHET_BASE));
  commit(root);
  const legacy = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  put(root, ".agents/probes/new-big.cjs", "x".repeat(50_000));
  put(root, ".claude/hooks/another.mjs", "x".repeat(70_000));
  put(root, ".agents/probes/a.cjs", probe(5));
  const update = bin(root, "ratchet", ["--update"]);
  assert.equal(update.status, 0, update.stderr);
  assert.deepEqual(Object.keys(readCeilings(root).oversizeFiles).sort(), [
    ".agents/probes/a.cjs",
    ".agents/probes/new-big.cjs",
    ".claude/hooks/another.mjs",
  ]);
  commit(root);
  const adopted = bin(root, "ratchet", ["--base", legacy]);
  assert.equal(adopted.status, 1, adopted.stderr);
  assert.match(
    adopted.stderr,
    /adds an oversize allowance for \.agents\/probes\/new-big\.cjs\./,
  );
  assert.match(
    adopted.stderr,
    /adds an oversize allowance for \.claude\/hooks\/another\.mjs\./,
  );
  assert.match(
    adopted.stderr,
    /raises the oversize allowance of \.agents\/probes\/a\.cjs from 20001 bytes on the base to 20006\./,
  );
});
