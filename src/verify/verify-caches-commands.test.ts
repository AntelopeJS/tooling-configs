import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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

/** An `ajs` whose arguments are a project and the modules it installs there, one after another, with the fake installer. */
function ajsBin(fake: FakeAjs): string {
  return `const { execFileSync } = require("node:child_process");
const [project, ...modules] = process.argv.slice(2);
for (const name of modules) execFileSync(process.execPath, [${JSON.stringify(fake.packages)}, project, name]);
`;
}

/** Journeys that install two modules in one command, through `ajs` or through a shell that also edits the first. */
function config(fake: FakeAjs): string {
  const script = `"$0" "$1" "$2" @acme/api && echo BROKEN > "$2/.antelope/cache/@acme/api/value.txt" && "$0" "$1" "$2" @acme/extra`;
  return `import { readFileSync } from "node:fs";
import { join } from "node:path";
import { equal } from ${JSON.stringify(CHECKS)};
const values = (project) => ["@acme/api", "@acme/extra"].map((name) => readFileSync(join(project, ".antelope/cache", name, "value.txt"), "utf8"));
export default {
  doors: ${PUBLISH_DOORS},
  setup: [["node", "-e", "0"]],
  journeys: {
    pair: {
      title: "installs two modules with one ajs command",
      entryPoint: "node",
      async run(context) {
        const project = context.fixture();
        await context.ajs("install both", [project, "@acme/api", "@acme/extra"]);
        context.expect(context.step("read"), [equal("both modules are as installed", values(project), ["installed\\n", "installed\\n"])]);
      },
    },
    bundler: {
      title: "installs a module, edits it and installs another in one shell command",
      entryPoint: "node",
      async run(context) {
        const project = context.fixture();
        await context.command("install, edit, install", "sh", ["-c", ${JSON.stringify(script)}, process.execPath, ${JSON.stringify(fake.packages)}, project]);
        context.expect(context.step("read"), [equal("the edit landed", values(project), ["BROKEN\\n", "installed\\n"])]);
      },
    },
  },
};
`;
}

function cacheRepo(t: TestContext) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-caches-commands-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const fake = fakeAjs(tmp);
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "package.json": '{"name":"demo","type":"module","version":"1.0.0"}\n',
    "node_modules/@antelopejs/interface-core/package.json":
      '{"name":"@antelopejs/interface-core","version":"1.0.0"}\n',
    "node_modules/@antelopejs/core/package.json":
      '{"name":"@antelopejs/core","bin":{"ajs":"ajs.cjs"}}\n',
    "node_modules/@antelopejs/core/ajs.cjs": ajsBin(fake),
    ".gitignore": "",
    "src/api.ts": "export const api = 1;\n",
    [`${SKILL}/verify.config.ts`]: config(fake),
    [`${SKILL}/features/pair.md`]: feature([], ["pair"]),
    [`${SKILL}/features/bundle.md`]: feature([], ["bundler"]),
  });
  const installs = () => read(tmp, "installs.log").split("\n").filter(Boolean);
  const journey = (run: string, name: string) => {
    const result = verify(root, tmp, ["journey", run, name]);
    return { status: result.status, output: result.stdout + result.stderr };
  };
  return { root, tmp, installs, journey };
}

test("a module one shell command edited before installing another stays out of the kept cache, where a bound taken from the manifest that command wrote last hides the edit", (t) => {
  const { root, tmp, installs, journey } = cacheRepo(t);
  const run = newRun(root, tmp);
  const bundled = journey(run, "bundle");
  assert.equal(bundled.status, 0, bundled.output);
  const result = journey(run, "pair");
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(installs(), [
    "@acme/api",
    "@acme/extra",
    "@acme/api",
    "@acme/extra",
  ]);
  assert.match(
    read(run, "evidence/bundle/bundler/04-module-cache-not-kept/note.txt"),
    /@acme\/api@1\.0\.0 and @acme\/extra@1\.0\.0 appeared in one command that is not ajs/,
  );
});

test("two modules one ajs command installed are kept, where refusing every command that adds several modules installs them again in each journey", (t) => {
  const { root, tmp, installs, journey } = cacheRepo(t);
  const run = newRun(root, tmp);
  for (let round = 0; round < 2; round += 1) {
    const result = journey(run, "pair");
    assert.equal(result.status, 0, result.output);
  }
  assert.deepEqual(installs(), ["@acme/api", "@acme/extra"]);
});
