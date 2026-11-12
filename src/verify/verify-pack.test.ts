import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { read } from "../guardrails/helpers/test-repo.ts";
import { PUBLISH_DOORS, verify, verifyRepo } from "./helpers/verify-repo.ts";

const SKILL = ".agents/skills/verify-interface";

/** A script body that appends one line to `builds.txt` and leaves a `dist` behind. */
const BUILD = `node -e "const fs = require('fs'); fs.appendFileSync('builds.txt', 'x\\\\n'); fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/index.js', '')"`;

function interfaceRepo(
  t: TestContext,
  scripts: Record<string, string>,
  setup?: string[][],
) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-pack-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "package.json": `${JSON.stringify({ name: "demo", type: "module", version: "1.0.0", files: ["dist"], scripts })}\n`,
    "src/index.ts": "export {};\n",
    [`${SKILL}/SKILL.md`]: "synced\n",
    [`${SKILL}/verify.config.ts`]: `export default {
  doors: ${PUBLISH_DOORS},
  ${setup === undefined ? "" : `setup: ${JSON.stringify(setup)},`}
  journeys: {},
};
`,
  });
  return { root, tmp };
}

function created(root: string, tmp: string) {
  const result = verify(root, tmp, ["new", "--kind", "interface"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim().split("\n").at(-1) ?? "";
}

function builds(root: string): number {
  return read(root, "builds.txt").trim().split("\n").length;
}

test("new builds an interface once when its prepack is the build, and dist is in the tarball and next to src", (t) => {
  const { root, tmp } = interfaceRepo(t, {
    build: BUILD,
    prepack: "pnpm run build",
  });
  const run = created(root, tmp);
  assert.equal(builds(root), 1);
  assert.equal(read(run, "pack/package/dist/index.js"), "");
  assert.equal(read(root, "dist/index.js"), "");
});

test("new runs a prepack that does more than build, and still builds once more through its setup build", (t) => {
  const { root, tmp } = interfaceRepo(t, {
    build: BUILD,
    prepack:
      "pnpm run build && node -e \"require('fs').writeFileSync('dist/generated.js', '')\"",
  });
  const run = created(root, tmp);
  assert.equal(builds(root), 2);
  assert.equal(read(run, "pack/package/dist/generated.js"), "");
});

test("new keeps the custom setup commands of an interface whose prepack builds", (t) => {
  const { root, tmp } = interfaceRepo(
    t,
    { build: BUILD, prepack: "pnpm run build" },
    [["pnpm", "run", "build"]],
  );
  created(root, tmp);
  assert.equal(builds(root), 2);
});

test("a failed pnpm pack names its evidence folder and carries the message its prepack printed on stdout", (t) => {
  const { root, tmp } = interfaceRepo(
    t,
    {
      prepack: "node -e \"console.log('prepack-said-this'); process.exit(1)\"",
    },
    [],
  );
  const result = verify(root, tmp, ["new", "--kind", "interface"]);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /pnpm pack failed; see \S+[\\/]evidence[\\/]setup[\\/]pack/,
  );
  assert.match(result.stderr, /stdout:[\s\S]*prepack-said-this/);
});
