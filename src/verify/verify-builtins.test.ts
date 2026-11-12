import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { put, read } from "../guardrails/helpers/test-repo.ts";
import { installNodeFake, pathWith } from "./helpers/fake-bin.ts";
import {
  evidence,
  feature,
  PUBLISH_DOORS,
  verify,
  verifyRepo,
} from "./helpers/verify-repo.ts";

const SKILL = ".agents/skills/verify-template";

/** A fake `ajs`: `config set git` writes the URL into HOME, `project init` writes a project, with no config when `NO_CONFIG` is set, and logs it, `project dev` prints its ready line until SIGINT. */
const AJS = String.raw`const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const [command, sub, target] = process.argv.slice(2);
if (command === "config") writeFileSync(join(process.env.HOME, "git.txt"), process.argv[5]);
else if (sub === "init") {
  appendFileSync(process.env.SCAFFOLD_LOG, "init\n");
  mkdirSync(target, { recursive: true });
  if (!process.env.NO_CONFIG) writeFileSync(join(target, "antelope.config.ts"), "export default {};\n");
} else {
  process.on("SIGINT", () => process.exit(130));
  console.log("ready");
  setInterval(() => {}, 1000);
}
`;

/** A fake `pnpm`: `install` logs itself; `run checks` passes only when HOME points `ajs` at a manifest, as a real `ajs` in the checks would read it. */
const PNPM = String.raw`const { appendFileSync, statSync } = require("node:fs");
const { join } = require("node:path");
if (process.argv[2] === "install") {
  appendFileSync(process.env.SCAFFOLD_LOG, "install\n");
  process.exit(0);
}
try {
  process.exit(statSync(join(process.env.HOME, "git.txt")).size > 0 ? 0 : 1);
} catch {
  process.exit(1);
}
`;

/** A repo journey that prepares the key the pack's journeys use, with the same init and install. */
const CONFIG = `export default {
  doors: ${PUBLISH_DOORS},
  setup: [["node", "-e", "0"]],
  template: { name: "demo", probe: { log: /ready/, settleMs: 0 } },
  journeys: {
    files: {
      title: "the scaffolded project holds its config",
      entryPoint: "ajs project init",
      async run(context) {
        const project = await context.prepared("scaffolded", async (folder) => {
          const init = await context.scaffold("ajs project init", folder);
          context.expect(init.folder, [{ name: "init passed", pass: init.exitCode === 0, detail: "" }], { critical: true });
          context.tree("scaffolded tree", folder);
          const install = await context.command("pnpm install", "pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { cwd: folder });
          context.expect(install.folder, [{ name: "install passed", pass: install.exitCode === 0, detail: "" }], { critical: true });
        });
        const tree = context.tree("project", project);
        context.expect(tree.folder, [{ name: "config scaffolded", pass: tree.lines.some((line) => line.includes("antelope.config.ts")), detail: "" }]);
      },
    },
  },
};
`;

/** Runs the smoke feature, listing `journeys`, of a template repo whose `files` journey prepares `scaffolded`, and returns each journey's status and the scaffold log. */
function runSmoke(
  t: TestContext,
  journeys: string[],
  extra: Record<string, string> = {},
) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-builtins-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "package.json": '{"name":"demo","type":"module","version":"1.0.0"}\n',
    [`${SKILL}/SKILL.md`]: "synced\n",
    [`${SKILL}/verify.config.ts`]: CONFIG,
    [`${SKILL}/features/smoke.md`]: feature([], journeys),
  });
  put(
    root,
    "node_modules/@antelopejs/core/package.json",
    '{"name":"@antelopejs/core","bin":{"ajs":"ajs.cjs"}}\n',
  );
  put(root, "node_modules/@antelopejs/core/ajs.cjs", AJS);
  installNodeFake(join(tmp, "bin"), "pnpm", PNPM);
  const env = {
    PATH: pathWith(join(tmp, "bin")),
    SCAFFOLD_LOG: join(tmp, "scaffold.log"),
    ...extra,
  };
  const created = verify(root, tmp, ["new", "--kind", "template"], env);
  assert.equal(created.status, 0, created.stdout + created.stderr);
  const run = created.stdout.trim().split("\n").at(-1) ?? "";
  verify(root, tmp, ["journey", run, "smoke", "--kind", "template"], env);
  verify(root, tmp, ["clean", run, "--kind", "template"], env);
  const statuses = evidence(run, "smoke/feature.json").map(
    (result: { journey: string; status: string }) =>
      `${result.journey} ${result.status}`,
  );
  return { statuses, log: read(tmp, "scaffold.log") };
}

test("scaffold-dev and scaffold-checks copy the project a repo journey prepared as `scaffolded`, so the run scaffolds and installs once, and each still points ajs at the offline manifest in its own HOME", (t) => {
  const { statuses, log } = runSmoke(t, [
    "files",
    "scaffold-dev",
    "scaffold-checks",
  ]);
  assert.deepEqual(statuses, [
    "files PASS",
    "scaffold-dev PASS",
    "scaffold-checks PASS",
  ]);
  assert.equal(log, "init\ninstall\n");
});

test("scaffold-checks fails on a copied project without antelope.config.ts, though the repo journey that built it checks no config", (t) => {
  const { statuses } = runSmoke(t, ["files", "scaffold-checks"], {
    NO_CONFIG: "1",
  });
  assert.deepEqual(statuses, ["files FAIL", "scaffold-checks FAIL"]);
});
