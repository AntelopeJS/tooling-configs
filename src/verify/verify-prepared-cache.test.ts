import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { read } from "../guardrails/helpers/test-repo.ts";
import { fakeAjs } from "./helpers/fake-ajs.ts";
import {
  CHECKS,
  feature,
  PUBLISH_DOORS,
  verify,
  verifyRepo,
} from "./helpers/verify-repo.ts";

const SKILL = ".agents/skills/verify-template";

/** An `ajs` whose `project init <path>` creates the project with an empty antelope.json; every other command succeeds and does nothing. */
const AJS = `const { mkdirSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const [scope, action, path] = process.argv.slice(2);
if (scope === "project" && action === "init") {
  mkdirSync(resolve(path), { recursive: true });
  writeFileSync(join(resolve(path), "antelope.json"), '{"modules":{}}\\n');
}
`;

/** Two journeys that each take the prepared scaffold, install `@acme/api` into its project, as \`ajs project dev\` does, and read it. */
function config(packages: string): string {
  const journey = (id: string) => `
    ${id}: {
      title: "installs a registry module into its copy of the prepared project",
      entryPoint: "node",
      async run(context) {
        const folder = await context.prepared("app", async (built) => {
          const init = await context.scaffold("init", join(built, "app"));
          context.expect(init.folder, [exitIs(init, 0)]);
        });
        const project = join(folder, "app");
        const installed = await context.command("install", process.execPath, [${JSON.stringify(packages)}, project, "@acme/api"]);
        context.expect(installed.folder, [
          exitIs(installed, 0),
          equal("the module is installed", readFileSync(join(project, ".antelope/cache/@acme/api/value.txt"), "utf8"), "installed\\n"),
        ]);
      },
    },`;
  return `import { readFileSync } from "node:fs";
import { join } from "node:path";
import { equal, exitIs } from ${JSON.stringify(CHECKS)};
export default {
  doors: ${PUBLISH_DOORS},
  template: { name: "demo", probe: { log: /ready/ } },
  journeys: {${journey("builder")}${journey("copier")}
  },
};
`;
}

function templateRepo(t: TestContext) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-prepared-cache-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const fake = fakeAjs(tmp);
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "package.json": '{"name":"demo","type":"module","version":"1.0.0"}\n',
    "node_modules/@antelopejs/core/package.json":
      '{"name":"@antelopejs/core","version":"1.0.0","bin":{"ajs":"ajs.cjs"}}\n',
    "node_modules/@antelopejs/core/ajs.cjs": AJS,
    ".gitignore": "node_modules\n",
    [`${SKILL}/SKILL.md`]: "synced\n",
    [`${SKILL}/verify.config.ts`]: config(fake.packages),
    [`${SKILL}/features/build.md`]: feature([], ["builder"]),
    [`${SKILL}/features/copy.md`]: feature([], ["copier"]),
  });
  const run = (args: string[]) => {
    const result = verify(root, tmp, [...args, "--kind", "template"]);
    return { status: result.status, output: result.stdout + result.stderr };
  };
  const installs = () =>
    existsSync(fake.log) ? read(tmp, "installs.log").split("\n").length - 1 : 0;
  return { run, installs };
}

test("a journey that copies a prepared scaffold starts with the registry modules an earlier passing journey installed, where a copy the module cache never seeds installs them again", (t) => {
  const { run, installs } = templateRepo(t);
  const created = run(["new"]);
  assert.equal(created.status, 0, created.output);
  const folder = created.output.trim().split("\n").at(-1) ?? "";
  for (const name of ["build", "copy"]) {
    const result = run(["journey", folder, name]);
    assert.equal(result.status, 0, result.output);
  }
  assert.equal(installs(), 1);
});
