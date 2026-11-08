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
  runEntries,
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

/** Journeys that install registry modules, as \`ajs project dev\` does, into a scaffolded project of their own or into their copy of a prepared one. */
const JOURNEYS = `
    plain: {
      title: "installs @acme/api into a project it scaffolds",
      entryPoint: "node",
      async run(context) {
        const project = join(context.work, "plain");
        await context.scaffold("init", project);
        await install(context, project, "@acme/api");
      },
    },
    builder: {
      title: "installs @acme/api into its copy of the prepared project",
      entryPoint: "node",
      async run(context) {
        await install(context, join(await scaffolded(context), "app"), "@acme/api");
      },
    },
    copier: {
      title: "installs @acme/api into its copy of the prepared project",
      entryPoint: "node",
      async run(context) {
        await install(context, join(await scaffolded(context), "app"), "@acme/api");
      },
    },
    extender: {
      title: "installs @acme/other into its copy of the prepared project",
      entryPoint: "node",
      async run(context) {
        await install(context, join(await scaffolded(context), "app"), "@acme/other");
      },
    },
    mover: {
      title: "holds only what a build that scaffolds then moves its project left",
      entryPoint: "node",
      async run(context) {
        const folder = await moved(context);
        context.expect(context.step("listing"), [equal("the copy holds only app", readdirSync(folder), ["app"])]);
      },
    },
    follower: {
      title: "holds only what a build that scaffolds then moves its project left",
      entryPoint: "node",
      async run(context) {
        const folder = await moved(context);
        context.expect(context.step("listing"), [equal("the copy holds only app", readdirSync(folder), ["app"])]);
      },
    },`;

function config(packages: string): string {
  return `import { readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { equal, exitIs } from ${JSON.stringify(CHECKS)};
const install = async (context, project, name) => {
  const installed = await context.command("install " + name, process.execPath, [${JSON.stringify(packages)}, project, name]);
  context.expect(installed.folder, [
    exitIs(installed, 0),
    equal("the module is installed", readFileSync(join(project, ".antelope/cache", name, "value.txt"), "utf8"), "installed\\n"),
  ]);
};
const scaffolded = (context) =>
  context.prepared("app", async (built) => {
    const init = await context.scaffold("init", join(built, "app"));
    context.expect(init.folder, [exitIs(init, 0)]);
  });
const moved = (context) =>
  context.prepared("moved", async (built) => {
    const init = await context.scaffold("init", join(built, "tmp"));
    renameSync(join(built, "tmp"), join(built, "app"));
    context.expect(init.folder, [exitIs(init, 0)]);
  });
export default {
  doors: ${PUBLISH_DOORS},
  template: { name: "demo", probe: { log: /ready/ } },
  journeys: {${JOURNEYS}
  },
};
`;
}

const IDS = ["plain", "builder", "copier", "extender", "mover", "follower"];

/** A template run with a stub `ajs`; `journeys` runs the named journeys in order, each as its own `journey` command, and returns their exit statuses. */
function templateRun(t: TestContext) {
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
    ...Object.fromEntries(
      IDS.map((id) => [`${SKILL}/features/${id}.md`, feature([], [id])]),
    ),
  });
  const run = (args: string[]) => {
    const result = verify(root, tmp, [...args, "--kind", "template"]);
    return { status: result.status, output: result.stdout + result.stderr };
  };
  const created = run(["new"]);
  assert.equal(created.status, 0, created.output);
  const folder = created.output.trim().split("\n").at(-1) ?? "";
  const journeys = (...names: string[]) =>
    names.map((name) => run(["journey", folder, name]));
  const installs = () =>
    existsSync(fake.log) ? read(tmp, "installs.log").split("\n").length - 1 : 0;
  const kept = () => {
    const store = join(folder, "ajs-cache");
    return existsSync(store)
      ? runEntries(store).filter((name) => !name.startsWith(".")).length
      : 0;
  };
  return { journeys, installs, kept };
}

/** The exit status of each journey command. */
function statuses(results: { status: number | null }[]): (number | null)[] {
  return results.map((result) => result.status);
}

test("a journey that copies a prepared scaffold starts with the registry modules an earlier passing journey installed, where a copy the module cache never seeds installs them again", (t) => {
  const { journeys, installs } = templateRun(t);
  assert.deepEqual(statuses(journeys("builder", "copier")), [0, 0]);
  assert.equal(installs(), 1);
});

test("a copy of a build seeded with a kept cache keeps the larger cache it installs, where a copy that judges its copied folders by the manifest's time keeps nothing", (t) => {
  const { journeys, kept } = templateRun(t);
  assert.deepEqual(
    statuses(journeys("plain", "builder", "extender")),
    [0, 0, 0],
  );
  assert.equal(kept(), 2);
});

test("a copy seeds no project the build scaffolded and then moved, where seeding every path the build scaffolded recreates the old path in each copy", (t) => {
  const { journeys } = templateRun(t);
  const results = journeys("plain", "mover", "follower");
  assert.deepEqual(statuses(results), [0, 0, 0], results.at(-1)?.output);
});
