import assert from "node:assert/strict";
import test from "node:test";

import manifest from "../../package.json" with { type: "json" };
import { agentsBlock } from "./agents-block.ts";

/** Every agent session in every synced repository reads the block, so it stays near 2 KB. */
const MAX_BLOCK_BYTES = 2400;

test("the managed block stays within its byte cap for every profile and repository shape", () => {
  for (const profile of ["full", "template"] as const)
    for (const glossary of [undefined, "docs/GLOSSARY.md"]) {
      const block = agentsBlock({ profile, glossary });
      assert.ok(
        Buffer.byteLength(block) <= MAX_BLOCK_BYTES,
        `${profile}: ${Buffer.byteLength(block)} bytes`,
      );
    }
});

test("the full block sends the full checks to CI and names the fast local checks", () => {
  const block = agentsBlock({ profile: "full", glossary: undefined });
  assert.match(block, /CI runs `pnpm run checks` in full/);
  assert.match(block, /`pnpm exec oxlint <files>`/);
  assert.doesNotMatch(block, /Finish every change with `pnpm run checks`/);
});

test("a block of any profile names only commands the pack ships", () => {
  const shipped = new Set(Object.keys(manifest.bin));
  const removed = /ratchet|body-check|proof stamp|verify:lockfiles/i;
  for (const profile of ["full", "template"] as const) {
    const block = agentsBlock({ profile, glossary: "docs/GLOSSARY.md" });
    assert.doesNotMatch(block, removed, profile);
    for (const [name] of block.matchAll(/antelopejs-[a-z-]+/g))
      if (name !== "antelopejs-sync" && name !== "antelopejs-guardrails")
        assert.ok(shipped.has(name), `${profile}: ${name} is not shipped`);
  }
});
