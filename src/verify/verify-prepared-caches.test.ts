import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { put, read } from "../guardrails/helpers/test-repo.ts";
import { fakeAjs } from "./helpers/fake-ajs.ts";
import {
  CHECKS,
  feature,
  newRun,
  PUBLISH_DOORS,
  verify,
  verifyRepo,
} from "./helpers/verify-repo.ts";
import type { FakeAjs } from "./helpers/fake-ajs.ts";

const SKILL = ".agents/skills/verify-module";

/** An `ajs` whose `project init <folder>` creates the folder, as a template's scaffold would, and whose `config set` does nothing. */
const AJS = `const { mkdirSync } = require("node:fs");
const [command, action, folder] = process.argv.slice(2);
if (command === "project" && action === "init") mkdirSync(folder, { recursive: true });`;

/** Journeys that scaffold a project inside a prepared folder, at its root or in `app/`, and install fake registry modules into it. */
function config(fake: FakeAjs): string {
  return `import { readFileSync } from "node:fs";
import { join } from "node:path";
import { equal, exitIs } from ${JSON.stringify(CHECKS)};
const install = async (context, project, name) => {
  await context.command("install " + name, process.execPath, [${JSON.stringify(fake.packages)}, project, name, ""]);
  return join(project, ".antelope/cache", name);
};
const scaffolded = (context, at) =>
  context.prepared(at === "." ? "root" : "nested", async (folder) => {
    const init = await context.scaffold("ajs project init", join(folder, at));
    context.expect(init.folder, [exitIs(init, 0)]);
  }).then((folder) => join(folder, at));
const installs = (names) => async (context, project) => {
  const modules = [];
  for (const name of names) modules.push(await install(context, project, name));
  context.expect(context.step("read"), modules.map((module) =>
    equal(module + " is installed", readFileSync(join(module, "value.txt"), "utf8"), "installed\\n")));
};
const journey = (title, project, names) => ({
  title,
  entryPoint: "node",
  run: async (context) => installs(names)(context, await project(context)),
});
export default {
  doors: ${PUBLISH_DOORS},
  journeys: {
    root: journey("installs @acme/api in a project prepared at the folder's root", (context) => scaffolded(context, "."), ["@acme/api"]),
    "root-copy": journey("installs @acme/api in its copy of the project prepared at the folder's root", (context) => scaffolded(context, "."), ["@acme/api"]),
    nested: journey("installs @acme/api in a project prepared in app/", (context) => scaffolded(context, "app"), ["@acme/api"]),
    extra: journey("installs @acme/api and @acme/extra in a project prepared in app/", (context) => scaffolded(context, "app"), ["@acme/api", "@acme/extra"]),
    both: journey("installs @acme/api and @acme/extra in a fixture", async (context) => context.fixture(), ["@acme/api", "@acme/extra"]),
  },
};
`;
}

function preparedCacheRepo(t: TestContext) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-prepared-caches-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const fake = fakeAjs(tmp);
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "package.json": '{"name":"demo","type":"module","version":"1.0.0"}\n',
    "node_modules/@antelopejs/interface-core/package.json":
      '{"name":"@antelopejs/interface-core","version":"1.0.0"}\n',
    ".gitignore": "",
    "src/api.ts": "export const api = 1;\n",
    [`${SKILL}/verify.config.ts`]: config(fake),
    [`${SKILL}/features/root.md`]: feature([], ["root"]),
    [`${SKILL}/features/copy.md`]: feature([], ["root-copy"]),
    [`${SKILL}/features/nested.md`]: feature([], ["nested"]),
    [`${SKILL}/features/extra.md`]: feature([], ["extra"]),
    [`${SKILL}/features/both.md`]: feature([], ["both"]),
  });
  put(
    root,
    "node_modules/@antelopejs/core/package.json",
    '{"name":"@antelopejs/core","bin":{"ajs":"ajs.cjs"}}\n',
  );
  put(root, "node_modules/@antelopejs/core/ajs.cjs", AJS);
  const installed = () =>
    existsSync(fake.log)
      ? read(tmp, "installs.log").split("\n").filter(Boolean)
      : [];
  const journey = (run: string, name: string) => {
    const result = verify(root, tmp, ["journey", run, name]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  return { root, tmp, installed, journey };
}

test("a copy of a project prepared at the folder's root starts with the modules the journey that built it installed, so it installs none of them again; an unseeded copy installs them cold", (t) => {
  const { root, tmp, installed, journey } = preparedCacheRepo(t);
  const run = newRun(root, tmp);
  journey(run, "root");
  journey(run, "copy");
  assert.match(
    read(run, "evidence/copy/root-copy/01-prepared-root/prepared.txt"),
    /is a copy of what root\/root prepared/,
  );
  assert.deepEqual(installed(), ["@acme/api"]);
});

test("a copy's module cache is followed like a scaffold's, so a module it installs is kept and a later journey's project starts with it; a copy seeded but not followed leaves @acme/extra to install again", (t) => {
  const { root, tmp, installed, journey } = preparedCacheRepo(t);
  const run = newRun(root, tmp);
  journey(run, "nested");
  journey(run, "extra");
  assert.match(
    read(run, "evidence/extra/extra/01-prepared-nested/prepared.txt"),
    /is a copy of what nested\/nested prepared/,
  );
  journey(run, "both");
  assert.deepEqual(installed(), ["@acme/api", "@acme/extra"]);
});
