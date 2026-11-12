import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { read } from "../guardrails/helpers/test-repo.ts";
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

/** Journeys whose modules `ajs` or the journey writes again after `ajs` installed them. */
const reinstalls = `
    reinstaller: {
      title: "installs the same version of a module twice",
      entryPoint: "node",
      async run(context) {
        const project = context.fixture();
        await install(context, project, "@acme/api", "fresh");
        context.expect(context.step("read"), [whole(await install(context, project, "@acme/api", "fresh"))]);
      },
    },
    tamperer: {
      title: "edits a module, then installs the same version of another again",
      entryPoint: "node",
      async run(context) {
        const project = context.fixture();
        const module = await install(context, project);
        await install(context, project, "@acme/extra", "fresh");
        writeFileSync(join(module, "value.txt"), "BROKEN\\n");
        context.expect(context.step("tamper"), [whole(await install(context, project, "@acme/extra", "fresh"))]);
      },
    },
    swapper: {
      title: "swaps a module for an edited copy, then installs the same version of another again",
      entryPoint: "node",
      async run(context) {
        const project = context.fixture();
        const module = await install(context, project);
        cpSync(module, module + ".copy", { recursive: true, verbatimSymlinks: true });
        writeFileSync(join(module + ".copy", "value.txt"), "BROKEN\\n");
        rmSync(module, { recursive: true });
        renameSync(module + ".copy", module);
        context.expect(context.step("swap"), [whole(await install(context, project, "@acme/extra", "fresh"))]);
      },
    },
    faker: {
      title: "rebuilds a module it installed and writes the manifest again in one command",
      entryPoint: "node",
      async run(context) {
        const project = context.fixture();
        const module = await install(context, project);
        await install(context, project, "@acme/api", "fake");
        context.expect(context.step("fake"), [equal("the fake landed", readFileSync(join(module, "value.txt"), "utf8"), "FAKE\\n")]);
      },
    },
    pinner: {
      title: "installs a module from a lock record it wrote",
      entryPoint: "node",
      async run(context) {
        const project = context.fixture();
        mkdirSync(join(project, "antelope-lock/@acme/api@1.0.0"), { recursive: true });
        writeFileSync(join(project, "antelope-lock/@acme/api@1.0.0/pnpm-lock.yaml"), "pinned\\n");
        const module = await install(context, project);
        context.expect(context.step("pin"), [equal("the record pinned the module", readFileSync(join(module, "pnpm-lock.yaml"), "utf8"), "pinned\\n")]);
      },
    },`;

/** Journeys that install a git module from the fake remote. */
function gitJourneys(fake: FakeAjs): string {
  const commit = JSON.stringify([
    "-C",
    fake.clone,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "two",
  ]);
  const push = JSON.stringify([
    "-C",
    fake.clone,
    "push",
    "-q",
    fake.remote,
    "main",
  ]);
  return `
    mover: {
      title: "plants a file in the git module it installed, then installs it again after the remote moved",
      entryPoint: "node",
      async run(context) {
        const project = context.fixture();
        const module = await installGit(context, project, "A");
        writeFileSync(join(module, "dist/planted.txt"), "planted\\n");
        await context.command("commit", "git", ${commit});
        await context.command("push", "git", ${push});
        await installGit(context, project, "A");
        context.expect(context.step("move"), [equal("the module moved", readFileSync(join(module, "dist/built.txt"), "utf8"), "A\\n")]);
      },
    },
    cloner: {
      title: "installs the git module with install command A",
      entryPoint: "node",
      async run(context) {
        const module = await installGit(context, context.fixture(), "A");
        context.expect(context.step("read"), [equal("the module is as cloned", [readFileSync(join(module, "dist/built.txt"), "utf8"), existsSync(join(module, "dist/planted.txt"))], ["A\\n", false])]);
      },
    },
    mixer: {
      title: "installs a registry module and the git module with install command A",
      entryPoint: "node",
      async run(context) {
        const project = context.fixture();
        await installGit(context, project, "A");
        context.expect(context.step("read"), [whole(await install(context, project))]);
      },
    },
    rebuilder: {
      title: "installs the git module with install command B",
      entryPoint: "node",
      async run(context) {
        const module = await installGit(context, context.fixture(), "B");
        context.expect(context.step("read"), [equal("command B built the module", readFileSync(join(module, "dist/built.txt"), "utf8"), "B\\n")]);
      },
    },`;
}

/** Journeys that install fake registry modules with the installer command, as journeys run `ajs`. */
function config(fake: FakeAjs, fail: string): string {
  return `import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { equal } from ${JSON.stringify(CHECKS)};
const install = async (context, project, name = "@acme/api", mode = "") => {
  await context.command("install " + name, process.execPath, [${JSON.stringify(fake.packages)}, project, name, mode]);
  return join(project, ".antelope/cache", name);
};
const installGit = async (context, project, command) => {
  await context.command("install git", process.execPath, [${JSON.stringify(fake.git)}, project, ${JSON.stringify(fake.remote)}, command]);
  return join(project, ".antelope/cache", ${JSON.stringify(fake.remote)}.replace(/[^a-zA-Z0-9_]/g, "_"));
};
const whole = (module) => equal("the module is as a fresh install left it", ["value.txt", "file-399.js", "pnpm-lock.yaml"].map((file) => readFileSync(join(module, file), "utf8")), ["installed\\n", "module.exports = 399;\\n", "fresh\\n"]);
export default {
  doors: ${PUBLISH_DOORS},
  setup: [["node", "-e", "0"]],
  journeys: {
    reader: {
      title: "reads the installed module",
      entryPoint: "node",
      async run(context) {
        const module = await install(context, context.fixture());
        context.expect(context.step("read"), [whole(module), equal("the fail marker is absent", existsSync(${JSON.stringify(fail)}), false)]);
      },
    },
    writer: {
      title: "writes through the module's relative link",
      entryPoint: "node",
      async run(context) {
        const module = await install(context, context.fixture());
        appendFileSync(join(module, "node_modules/link"), "dirty\\n");
        context.expect(context.step("write"), [equal("the write landed", readFileSync(join(module, "value.txt"), "utf8"), "installed\\ndirty\\n")]);
      },
    },
    breaker: {
      title: "edits the module it installed and passes",
      entryPoint: "node",
      async run(context) {
        const module = await install(context, context.fixture());
        writeFileSync(join(module, "value.txt"), "BROKEN\\n");
        context.expect(context.step("break"), [equal("the edit landed", readFileSync(join(module, "value.txt"), "utf8"), "BROKEN\\n")]);
      },
    },
    extender: {
      title: "edits the module it installed, then installs another",
      entryPoint: "node",
      async run(context) {
        const project = context.fixture();
        const module = await install(context, project);
        writeFileSync(join(module, "value.txt"), "BROKEN\\n");
        await install(context, project, "@acme/extra");
        context.expect(context.step("extend"), [whole(join(project, ".antelope/cache/@acme/extra"))]);
      },
    },
    locker: {
      title: "leaves a file only its owner may read in the module",
      entryPoint: "node",
      async run(context) {
        const module = await install(context, context.fixture());
        writeFileSync(join(module, "locked.js"), "", { mode: 0 });
        context.expect(context.step("read"), [whole(module)]);
      },
    },
${reinstalls}
${gitJourneys(fake)}
    deleter: {
      title: "uses its copy after the run's kept cache is deleted",
      entryPoint: "node",
      async run(context) {
        const project = context.fixture();
        rmSync(join(context.work, "../../../ajs-cache"), { recursive: true, force: true });
        context.expect(context.step("read"), [whole(await install(context, project))]);
      },
    },
  },
};
`;
}

function cacheRepo(t: TestContext) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-caches-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const fake = fakeAjs(tmp);
  const fail = join(tmp, "fail");
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "package.json": '{"name":"demo","type":"module","version":"1.0.0"}\n',
    "node_modules/@antelopejs/interface-core/package.json":
      '{"name":"@antelopejs/interface-core","version":"1.0.0"}\n',
    ".gitignore": "",
    "src/api.ts": "export const api = 1;\n",
    [`${SKILL}/verify.config.ts`]: config(fake, fail),
    [`${SKILL}/features/smoke.md`]: feature([], ["reader"]),
    [`${SKILL}/features/write.md`]: feature(["src/**"], ["writer", "reader"]),
    [`${SKILL}/features/break.md`]: feature([], ["breaker"]),
    [`${SKILL}/features/extend.md`]: feature([], ["extender"]),
    [`${SKILL}/features/lock.md`]: feature([], ["locker"]),
    [`${SKILL}/features/delete.md`]: feature([], ["deleter"]),
    [`${SKILL}/features/reinstall.md`]: feature([], ["reinstaller"]),
    [`${SKILL}/features/tamper.md`]: feature([], ["tamperer"]),
    [`${SKILL}/features/swap.md`]: feature([], ["swapper"]),
    [`${SKILL}/features/fake.md`]: feature([], ["faker"]),
    [`${SKILL}/features/pin.md`]: feature([], ["pinner"]),
    [`${SKILL}/features/move.md`]: feature([], ["mover"]),
    [`${SKILL}/features/clone.md`]: feature([], ["cloner"]),
    [`${SKILL}/features/rebuild.md`]: feature([], ["rebuilder"]),
    [`${SKILL}/features/mix.md`]: feature([], ["mixer"]),
  });
  const installs = () =>
    existsSync(fake.log) ? read(tmp, "installs.log").split("\n").length - 1 : 0;
  const journey = (run: string, name: string) => {
    const result = verify(root, tmp, ["journey", run, name]);
    return { status: result.status, output: result.stdout + result.stderr };
  };
  return { root, tmp, fail, installs, journey };
}

test("a later journey of the run starts with the modules an earlier passing journey installed, and a new run installs them again", (t) => {
  const { root, tmp, installs, journey } = cacheRepo(t);
  const run = newRun(root, tmp);
  for (let round = 0; round < 2; round += 1) {
    const result = journey(run, "smoke");
    assert.equal(result.status, 0, result.output);
  }
  assert.equal(installs(), 1);
  const next = newRun(root, tmp);
  assert.equal(journey(next, "smoke").status, 0);
  assert.equal(installs(), 2);
});

test("the fixture project tree a journey records is the same whether or not a kept cache seeds it, where seeding before the tree adds .antelope/cache to later journeys' evidence", (t) => {
  const { root, tmp, journey } = cacheRepo(t);
  const run = newRun(root, tmp);
  const tree = () =>
    read(run, "evidence/smoke/reader/01-fixture-project/tree.txt");
  assert.equal(journey(run, "smoke").status, 0);
  const first = tree();
  assert.equal(journey(run, "smoke").status, 0);
  assert.equal(tree(), first);
});

test("a write through a relative link of a seeded module stays in its journey", (t) => {
  const { root, tmp, installs, journey } = cacheRepo(t);
  const run = newRun(root, tmp);
  assert.equal(journey(run, "smoke").status, 0);
  const result = journey(run, "write");
  assert.equal(result.status, 0, result.output);
  assert.equal(installs(), 1);
});

test("a passing journey that edits a module it installed keeps no cache, so a later journey installs the module whole and the evidence says why", (t) => {
  const { root, tmp, installs, journey } = cacheRepo(t);
  const run = newRun(root, tmp);
  assert.equal(journey(run, "break").status, 0);
  const result = journey(run, "smoke");
  assert.equal(result.status, 0, result.output);
  assert.equal(installs(), 2);
  assert.match(
    read(run, "evidence/break/breaker/04-module-cache-not-kept/note.txt"),
    /value\.txt changed after ajs installed @acme\/api@1\.0\.0/,
  );
});

test("an edit to a module stays out of the kept cache when the journey installs another module after it", (t) => {
  const { root, tmp, journey } = cacheRepo(t);
  const run = newRun(root, tmp);
  assert.equal(journey(run, "extend").status, 0);
  const result = journey(run, "smoke");
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(read(tmp, "installs.log").split("\n").filter(Boolean), [
    "@acme/api",
    "@acme/extra",
    "@acme/api",
  ]);
});

test("a journey that fails leaves no cache behind, so the next journey installs again", (t) => {
  const { root, tmp, fail, installs, journey } = cacheRepo(t);
  const run = newRun(root, tmp);
  writeFileSync(fail, "");
  assert.equal(journey(run, "smoke").status, 1);
  rmSync(fail);
  const result = journey(run, "smoke");
  assert.equal(result.status, 0, result.output);
  assert.equal(installs(), 2);
});

test("deleting the run's kept cache while a journey uses its copy leaves that journey whole", (t) => {
  const { root, tmp, installs, journey } = cacheRepo(t);
  const run = newRun(root, tmp);
  assert.equal(journey(run, "smoke").status, 0);
  assert.ok(existsSync(join(run, "ajs-cache")), "the run kept a cache");
  const result = journey(run, "delete");
  assert.equal(result.status, 0, result.output);
  assert.equal(installs(), 1);
});

test("a cache that cannot be copied whole is not kept, so the next journey installs and keeps its own", (t) => {
  const { root, tmp, installs, journey } = cacheRepo(t);
  const run = newRun(root, tmp);
  assert.equal(journey(run, "lock").status, 0);
  for (let round = 0; round < 2; round += 1) {
    const result = journey(run, "smoke");
    assert.equal(result.status, 0, result.output);
  }
  assert.equal(installs(), 2);
});

test("a module ajs deleted and installed again at the same version is not kept, so a cache whose bound moved with each reinstall cannot stand in for it", (t) => {
  const { root, tmp, installs, journey } = cacheRepo(t);
  const run = newRun(root, tmp);
  assert.equal(journey(run, "reinstall").status, 0);
  const result = journey(run, "smoke");
  assert.equal(result.status, 0, result.output);
  assert.equal(installs(), 3);
  assert.match(
    read(
      run,
      "evidence/reinstall/reinstaller/05-module-cache-not-kept/note.txt",
    ),
    /@acme\/api was created again after ajs installed @acme\/api@1\.0\.0/,
  );
});

test("an edit to a module stays out of the kept cache when ajs installs the same version of another module again after it", (t) => {
  const { root, tmp, journey } = cacheRepo(t);
  const run = newRun(root, tmp);
  assert.equal(journey(run, "tamper").status, 0);
  const result = journey(run, "smoke");
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(read(tmp, "installs.log").split("\n").filter(Boolean), [
    "@acme/api",
    "@acme/extra",
    "@acme/extra",
    "@acme/api",
  ]);
});

test("a module folder the journey swapped for an edited copy stays out of the kept cache when ajs then writes the manifest", (t) => {
  const { root, tmp, journey } = cacheRepo(t);
  const run = newRun(root, tmp);
  assert.equal(journey(run, "swap").status, 0);
  const result = journey(run, "smoke");
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(read(tmp, "installs.log").split("\n").filter(Boolean), [
    "@acme/api",
    "@acme/extra",
    "@acme/api",
  ]);
});

test("a git module ajs moved to a new commit is not kept, so a file the journey planted before the move, which the hard reset leaves, does not reach a later journey's clone", (t) => {
  const { root, tmp, installs, journey } = cacheRepo(t);
  const run = newRun(root, tmp);
  const moved = journey(run, "move");
  assert.equal(moved.status, 0, moved.output);
  const result = journey(run, "clone");
  assert.equal(result.status, 0, result.output);
  assert.equal(installs(), 3);
});

test("a git module is not kept by name and version alone, so a journey whose install command differs builds it with its own", (t) => {
  const { root, tmp, installs, journey } = cacheRepo(t);
  const run = newRun(root, tmp);
  assert.equal(journey(run, "clone").status, 0);
  const result = journey(run, "rebuild");
  assert.equal(result.status, 0, result.output);
  assert.equal(installs(), 2);
  assert.match(
    read(run, "evidence/clone/cloner/04-module-cache-not-kept/note.txt"),
    /is not a registry version/,
  );
});

test("a module folder rebuilt in the command that also wrote the manifest is not taken for a reinstall, so its edit does not reach a later journey", (t) => {
  const { root, tmp, installs, journey } = cacheRepo(t);
  const run = newRun(root, tmp);
  assert.equal(journey(run, "fake").status, 0);
  const result = journey(run, "smoke");
  assert.equal(result.status, 0, result.output);
  assert.equal(installs(), 2);
});

test("a module ajs installed from a lock record is not kept, so a journey without the record gets the dependencies a fresh install resolves, not the pinned ones", (t) => {
  const { root, tmp, installs, journey } = cacheRepo(t);
  const run = newRun(root, tmp);
  assert.equal(journey(run, "pin").status, 0);
  const result = journey(run, "smoke");
  assert.equal(result.status, 0, result.output);
  assert.equal(installs(), 2);
  assert.match(
    read(run, "evidence/pin/pinner/04-module-cache-not-kept/note.txt"),
    /ajs installed @acme\/api@1\.0\.0 from the project's lock record/,
  );
});

test("a cache mixing a git module with a registry module keeps the registry module alone, so a later journey reuses it and still builds the git module with its own install command", (t) => {
  const { root, tmp, installs, journey } = cacheRepo(t);
  const run = newRun(root, tmp);
  assert.equal(journey(run, "mix").status, 0);
  for (const name of ["smoke", "rebuild"]) {
    const result = journey(run, name);
    assert.equal(result.status, 0, result.output);
  }
  assert.equal(installs(), 3);
});
