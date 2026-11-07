import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { PUBLISH_DOORS, verify, verifyRepo } from "./helpers/verify-repo.ts";

const SKILL = ".agents/skills/verify-interface";

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
    /pnpm pack failed; see \S+\/evidence\/setup\/pack/,
  );
  assert.match(result.stderr, /stdout:[\s\S]*prepack-said-this/);
});
