import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { put } from "../guardrails/helpers/test-repo.ts";
import {
  evidence,
  feature,
  newRun,
  PUBLISH_DOORS,
  verify,
  verifyRepo,
} from "./helpers/verify-repo.ts";

const SKILL = ".agents/skills/verify-module";

/** A fake `ajs project dev` that starts only the fixture's driver module, so a call reaches the interface the way the driver resolves it. */
const AJS = String.raw`const { join } = require("node:path");
process.on("SIGINT", () => process.exit(0));
require(join(process.cwd(), "driver", "index.js")).start();
`;

const MANIFEST = {
  name: "demo",
  type: "module",
  version: "1.0.0",
  main: "index.cjs",
  exports: {
    ".": "./index.cjs",
    "./interfaces/demo/dev": "./interface.cjs",
  },
  antelopeJs: { implements: ["demo"] },
};

test("a module that implements an interface of its own package is driven without a self link, and a call without an entry reaches its only interface subpath; a lookup in node_modules fails the fixture with demo is not installed, and a `.` default loads the module main, which has no Hello", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "verify-self-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "package.json": `${JSON.stringify(MANIFEST)}\n`,
    "index.cjs": "exports.construct = () => {};\n",
    "interface.cjs": 'exports.Hello = (name) => "hello " + name;\n',
    ".gitignore": "",
    [`${SKILL}/verify.config.ts`]: `export default {
  doors: ${PUBLISH_DOORS},
  setup: [["node", "-e", "0"]],
  journeys: {
    hello: {
      title: "call the interface the module implements",
      entryPoint: "ajs project dev",
      async run(context) {
        const project = context.fixture();
        const app = await context.dev("ajs project dev", project);
        const result = await context.call("call Hello", app, { path: ["Hello"], args: ["verify"] });
        context.expect(app.folder, [
          { name: "the call reached the interface", pass: result.value === "hello verify", detail: JSON.stringify(result.value) },
        ]);
      },
    },
  },
};
`,
    [`${SKILL}/features/smoke.md`]: feature([], ["hello"]),
  });
  put(
    root,
    "node_modules/@antelopejs/interface-core/package.json",
    '{"name":"@antelopejs/interface-core","version":"1.0.0"}\n',
  );
  put(
    root,
    "node_modules/@antelopejs/core/package.json",
    '{"name":"@antelopejs/core","bin":{"ajs":"ajs.cjs"}}\n',
  );
  put(root, "node_modules/@antelopejs/core/ajs.cjs", AJS);
  const run = newRun(root, tmp);
  const journey = verify(root, tmp, ["journey", run, "smoke"]);
  verify(root, tmp, ["clean", run]);
  assert.equal(journey.status, 0, journey.stdout + journey.stderr);
  const [result] = evidence(run, "smoke/feature.json");
  assert.equal(result.status, "PASS", JSON.stringify(result));
});
