import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { capture } from "./run.ts";

const SCENES = `export default [{ id: "home", route: "/", output: "docs/images/home.webp" }];\n`;

test("capture refuses an unbuilt module before it starts the demo, and names what to build", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "capture-run-"));
  const demoUrl = process.env.ANTELOPEJS_CAPTURE_DEMO_URL;
  process.env.ANTELOPEJS_CAPTURE_DEMO_URL = join(root, "no-demo");
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    if (demoUrl === undefined) delete process.env.ANTELOPEJS_CAPTURE_DEMO_URL;
    else process.env.ANTELOPEJS_CAPTURE_DEMO_URL = demoUrl;
  });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "@antelopejs/fixture",
      type: "module",
      main: "dist/index.js",
    }),
  );
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "captures.ts"), SCENES);
  await assert.rejects(
    capture(root, { check: true, scene: undefined, demoRef: "main" }),
    {
      message:
        "the module is not built, so the demo would load it without its build output:\n" +
        "  @antelopejs/fixture: dist/index.js is missing\n" +
        "Run pnpm run build first.",
    },
  );
});
