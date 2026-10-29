import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  evidence,
  feature,
  newRun,
  PUBLISH_DOORS,
  verify,
  verifyRepo,
} from "./helpers/verify-repo.ts";

const SKILL = ".agents/skills/verify-module";

test("a journey that writes the fixture project twice gets two separate projects", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "verify-fixture-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "package.json": '{"name":"demo","type":"module","version":"1.0.0"}\n',
    "node_modules/@antelopejs/interface-core/package.json":
      '{"name":"@antelopejs/interface-core","version":"1.0.0"}\n',
    ".gitignore": "",
    [`${SKILL}/verify.config.ts`]: `export default {
  doors: ${PUBLISH_DOORS},
  setup: [["node", "-e", "0"]],
  journeys: {
    twice: {
      title: "two fixtures in one journey",
      entryPoint: "node",
      async run(context) {
        const first = context.fixture();
        const second = context.fixture();
        context.expect(context.tree("projects", context.work).folder, [
          { name: "the projects are separate", pass: first !== second, detail: first + " " + second },
        ]);
      },
    },
  },
};
`,
    [`${SKILL}/features/smoke.md`]: feature([], ["twice"]),
  });
  const run = newRun(root, tmp);
  const journey = verify(root, tmp, ["journey", run, "smoke"]);
  assert.equal(journey.status, 0, journey.stdout + journey.stderr);
  const [result] = evidence(run, "smoke/feature.json");
  assert.equal(result.status, "PASS");
  for (const project of ["project", "fixture-2/project"])
    assert.equal(
      existsSync(join(run, "work/smoke/twice", project, "antelope.config.ts")),
      true,
      project,
    );
});
