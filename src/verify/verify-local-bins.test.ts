import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { put } from "../guardrails/helpers/test-repo.ts";
import {
  CHECKS,
  evidence,
  feature,
  newRun,
  PUBLISH_DOORS,
  verify,
  verifyRepo,
} from "./helpers/verify-repo.ts";

const SKILL = ".agents/skills/verify-module";

const CONFIG = `import { exitIs } from ${JSON.stringify(CHECKS)};
export default {
  doors: ${PUBLISH_DOORS},
  journeys: {
    "local-bin": {
      title: "runs a bin of the repository by its bare name",
      entryPoint: "local-bin",
      async run(context) {
        const result = await context.command("repository bin", "verify-local-probe", []);
        context.expect(result.folder, [exitIs(result, 0)]);
      },
    },
  },
};
`;

test("a journey finds the repository's own bins by bare name when the CLI is started without pnpm exec; a CLI that leaves PATH as the caller gave it fails the journey", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "verify-bins-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    [`${SKILL}/verify.config.ts`]: CONFIG,
    [`${SKILL}/features/smoke.md`]: feature([], ["local-bin"]),
  });
  put(root, "node_modules/.bin/verify-local-probe", "#!/bin/sh\nexit 0\n");
  chmodSync(join(root, "node_modules/.bin/verify-local-probe"), 0o755);
  const run = newRun(root, tmp);
  const journey = verify(root, tmp, ["journey", run, "smoke"], {
    PATH: "/usr/bin:/bin",
  });
  assert.equal(journey.status, 0, journey.stdout + journey.stderr);
  assert.equal(evidence(run, "smoke/feature.json")[0].status, "PASS");
});
