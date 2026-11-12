import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";

import { installFake } from "./helpers/fake-bin.ts";
import {
  CHECKS,
  evidence,
  feature,
  newRun,
  PUBLISH_DOORS,
  verify,
  verifyRepo,
} from "./helpers/verify-repo.ts";
import { withLocalBins } from "./workspace.ts";

const SKILL = ".agents/skills/verify-module";

const CONFIG = `import { exitIs } from ${JSON.stringify(CHECKS)};
export default {
  doors: ${PUBLISH_DOORS},
  setup: [["verify-local-probe"]],
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

test("a journey and a setup command find the repository's own bins first by bare name when the CLI is started without pnpm exec; a CLI that leaves PATH as the caller gave it, appends the bins, or sets them only for journeys fails", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "verify-bins-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    [`${SKILL}/verify.config.ts`]: CONFIG,
    [`${SKILL}/features/smoke.md`]: feature([], ["local-bin"]),
  });
  installFake(join(root, "node_modules/.bin"), "verify-local-probe", {
    sh: "#!/bin/sh\nexit 0\n",
    cmd: "@exit /b 0\n",
  });
  const shadow = join(tmp, "shadow");
  installFake(shadow, "verify-local-probe", {
    sh: "#!/bin/sh\nexit 7\n",
    cmd: "@exit /b 7\n",
  });
  const system =
    process.platform === "win32" ? process.env.PATH : "/usr/bin:/bin";
  const path = `${shadow}${delimiter}${system}`;
  const run = newRun(root, tmp, { PATH: path });
  const journey = verify(root, tmp, ["journey", run, "smoke"], { PATH: path });
  assert.equal(journey.status, 0, journey.stdout + journey.stderr);
  assert.equal(evidence(run, "smoke/feature.json")[0].status, "PASS");
});

test("a PATH that already lists the repository's bins keeps its order, and an unset or empty one stays so; a version that always moves the bins first shadows a package's own bins under pnpm exec, and one that fills an unset PATH drops the system default", () => {
  const root = resolve("/r");
  const bins = join(root, "node_modules", ".bin");
  const own = join(root, "packages", "a", "node_modules", ".bin");
  const listed = [own, `${bins}/`, "/usr/bin"].join(delimiter);
  assert.equal(withLocalBins(root, listed), listed);
  assert.equal(withLocalBins(root, "/usr/bin"), `${bins}${delimiter}/usr/bin`);
  assert.equal(withLocalBins(root, undefined), undefined);
  assert.equal(withLocalBins(root, ""), "");
});
