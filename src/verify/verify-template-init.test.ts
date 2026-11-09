import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { put, read } from "../guardrails/helpers/test-repo.ts";
import {
  feature,
  PUBLISH_DOORS,
  verify,
  verifyRepo,
} from "./helpers/verify-repo.ts";

const AJS = `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(process.env.CALLS_LOG, JSON.stringify(["ajs", ...args]) + "\\n");
if (args[1] === "init") {
  mkdirSync(args[2], { recursive: true });
  writeFileSync(join(args[2], args[0] === "module" ? "package.json" : "antelope.config.ts"), "{}\\n");
}
if (args[0] === "project" && args[1] === "dev") {
  console.log("ready");
  process.on("SIGINT", () => process.exit(130));
  setInterval(() => {}, 1000);
}
`;

const PNPM = `#!/bin/sh
node -e 'require("node:fs").appendFileSync(process.env.CALLS_LOG, JSON.stringify(["pnpm", ...process.argv.slice(1)]) + "\\n")' "$@"
exit 0
`;

const INIT_FLAGS = ["--pm", "pnpm", "--git-init"];

function templateRepo(t: TestContext, template: string) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-template-init-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const skill = ".agents/skills/verify-template";
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "package.json": '{"name":"demo","type":"module","version":"1.0.0"}\n',
    "node_modules/@antelopejs/core/package.json":
      '{"name":"@antelopejs/core","bin":{"ajs":"ajs.mjs"}}\n',
    "node_modules/@antelopejs/core/ajs.mjs": AJS,
    [`${skill}/SKILL.md`]: "synced\n",
    [`${skill}/verify.config.ts`]: `export default {
  doors: ${PUBLISH_DOORS},
  setup: [["node", "-e", "0"]],
  template: ${template},
};
`,
    [`${skill}/features/checks.md`]: feature([], ["scaffold-checks"]),
    [`${skill}/features/dev.md`]: feature([], ["scaffold-dev"]),
  });
  put(tmp, "bin/pnpm", PNPM);
  chmodSync(join(tmp, "bin/pnpm"), 0o755);
  const env = {
    PATH: `${join(tmp, "bin")}:${process.env.PATH}`,
    CALLS_LOG: join(tmp, "calls.log"),
  };
  const run =
    verify(root, tmp, ["new", "--kind", "template"], env)
      .stdout.trim()
      .split("\n")
      .at(-1) ?? "";
  return { root, tmp, env, run };
}

/** Runs one feature and returns the `ajs` and `pnpm` calls it made, without `ajs config set git`. */
function journeyCalls(
  repo: ReturnType<typeof templateRepo>,
  name: string,
): string[][] {
  const { root, tmp, env, run } = repo;
  put(tmp, "calls.log", "");
  const journey = verify(
    root,
    tmp,
    ["journey", run, name, "--kind", "template"],
    env,
  );
  assert.equal(journey.status, 0, journey.stdout + journey.stderr);
  return read(tmp, "calls.log")
    .trim()
    .split("\n")
    .map((line): string[] => JSON.parse(line))
    .filter((call) => call[1] !== "config");
}

const INSTALL = ["pnpm", "install", "--frozen-lockfile", "--prefer-offline"];

test("a module template is created once with ajs module init, then built and run in its playground project", (t) => {
  const repo = templateRepo(
    t,
    '{ name: "Demo Module", module: true, probe: { log: /ready/ } }',
  );
  const init = [
    "ajs",
    "module",
    "init",
    "scaffolded",
    "--template",
    "Demo Module",
  ];
  assert.deepEqual(journeyCalls(repo, "checks"), [
    [...init, ...INIT_FLAGS],
    INSTALL,
    ["pnpm", "run", "checks"],
  ]);
  assert.deepEqual(journeyCalls(repo, "dev"), [
    ["pnpm", "run", "build"],
    ["ajs", "project", "dev", "--watch", "--project", "playground"],
  ]);
});

test("a template without module set is still created once with ajs project init and run where it was created", (t) => {
  const repo = templateRepo(t, '{ name: "Demo App", probe: { log: /ready/ } }');
  const init = [
    "ajs",
    "project",
    "init",
    "scaffolded",
    "--template",
    "Demo App",
  ];
  assert.deepEqual(journeyCalls(repo, "checks"), [
    [...init, ...INIT_FLAGS],
    INSTALL,
    ["pnpm", "run", "checks"],
  ]);
  assert.deepEqual(journeyCalls(repo, "dev"), [
    ["ajs", "project", "dev", "--watch"],
  ]);
});
