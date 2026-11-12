import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { read } from "../guardrails/helpers/test-repo.ts";
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
  const tree = read(run, "evidence/smoke/twice/03-projects/tree.txt");
  for (const project of ["project", "fixture-2/project"])
    assert.match(
      tree,
      new RegExp(`^${project}/antelope\\.config\\.ts \\d+$`, "m"),
    );
});

test("the fixture project loads every companion module next to the module, where a fixture that writes only the module and the driver leaves the module's interface imports unserved", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "verify-fixture-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const api = {
    source: { type: "package", package: "@antelopejs/api", version: "1.0.0" },
    config: { servers: [{ protocol: "http", port: 5010 }] },
  };
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "package.json": '{"name":"demo","type":"module","version":"1.0.0"}\n',
    "node_modules/@antelopejs/interface-core/package.json":
      '{"name":"@antelopejs/interface-core","version":"1.0.0"}\n',
    ".gitignore": "",
    [`${SKILL}/verify.config.ts`]: `import { join } from "node:path";
import { pathToFileURL } from "node:url";

export default {
  doors: ${PUBLISH_DOORS},
  setup: [["node", "-e", "0"]],
  moduleConfig: () => ({ folder: "files" }),
  companions: () => ({ "@antelopejs/api": ${JSON.stringify(api)} }),
  journeys: {
    companions: {
      title: "the fixture loads the companion modules",
      entryPoint: "node",
      async run(context) {
        const project = context.fixture();
        const { default: config } = await import(pathToFileURL(join(project, "antelope.config.ts")).href);
        context.expect(context.tree("project", project).folder, [
          { name: "the companion is a module of the project", pass: JSON.stringify(config.modules["@antelopejs/api"]) === ${JSON.stringify(JSON.stringify(api))}, detail: JSON.stringify(config.modules) },
          { name: "the module keeps its config", pass: config.modules.demo?.config?.folder === "files", detail: JSON.stringify(config.modules.demo) },
          { name: "the driver is still loaded", pass: config.modules["verify-driver"] !== undefined, detail: Object.keys(config.modules).join(",") },
        ]);
      },
    },
  },
};
`,
    [`${SKILL}/features/smoke.md`]: feature([], ["companions"]),
  });
  const run = newRun(root, tmp);
  verify(root, tmp, ["journey", run, "smoke"]);
  const [result] = evidence(run, "smoke/feature.json");
  assert.equal(result.status, "PASS", JSON.stringify(result));
});
