import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parse } from "yaml";

import type { JsonObject } from "../garden/json.ts";

import {
  demoEnvironment,
  packageOverrides,
  parseCaptureArgs,
  DEMO_NOW,
  workspaceWithOverrides,
} from "./demo.ts";

function repo(t: test.TestContext, manifests: JsonObject): string {
  const root = mkdtempSync(join(tmpdir(), "capture-demo-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [dir, manifest] of Object.entries(manifests)) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify(manifest));
  }
  return root;
}

test("the demo runs on the fixed instant, in UTC, without simulators", () => {
  assert.equal(DEMO_NOW, "2026-06-15T09:00:00Z");
  const env = demoEnvironment({
    mongoUrl: "mongodb://127.0.0.1:27017",
    database: "docs",
    port: 3101,
  });
  assert.equal(env.HELIO_NOW, DEMO_NOW);
  assert.equal(env.HELIO_SIMULATORS, "off");
  assert.equal(env.TZ, "UTC");
  assert.equal(env.MONGODB_URL, "mongodb://127.0.0.1:27017");
  assert.equal(env.MONGODB_DATABASE, "docs");
  assert.equal(env.PORT, "3101");
  assert.equal(env.DMS_CLIENT_BASE_URL, "http://localhost:3101");
});

test("packageOverrides points every published package of the repository at its folder", (t) => {
  const root = repo(t, {
    ".": { name: "root-workspace", private: true },
    "packages/dms": { name: "@antelopejs/dms" },
    "packages/interface-dms": { name: "@antelopejs/interface-dms" },
    "packages/playground": { name: "@antelopejs/playground", private: true },
  });
  assert.deepEqual(packageOverrides(root), {
    "@antelopejs/dms": `file:${join(root, "packages/dms")}`,
    "@antelopejs/interface-dms": `file:${join(root, "packages/interface-dms")}`,
  });
});

test("a single-package repository overrides its own package", (t) => {
  const root = repo(t, { ".": { name: "@antelopejs/mollie" } });
  assert.deepEqual(packageOverrides(root), {
    "@antelopejs/mollie": `file:${root}`,
  });
});

test("parseCaptureArgs defaults to the main branch of the demo and every scene", () => {
  assert.deepEqual(parseCaptureArgs([]), {
    check: false,
    scene: undefined,
    demoRef: "main",
  });
  assert.deepEqual(
    parseCaptureArgs([
      "--check",
      "--scene",
      "sales",
      "--demo-ref",
      "campaign/integration",
    ]),
    {
      check: true,
      scene: "sales",
      demoRef: "campaign/integration",
    },
  );
  assert.throws(
    () => parseCaptureArgs(["--scenes", "a"]),
    /Usage: antelopejs-capture/,
  );
});

test("workspaceWithOverrides adds the overrides and the build allowances next to the existing workspace settings", () => {
  const text = workspaceWithOverrides(
    "packages:\n  - frontend-vue\noverrides:\n  left-pad: 1.3.0\n",
    { "@antelopejs/dms": "file:/repo/packages/dms" },
    ["esbuild"],
  );
  assert.deepEqual(parse(text), {
    packages: ["frontend-vue"],
    overrides: {
      "left-pad": "1.3.0",
      "@antelopejs/dms": "file:/repo/packages/dms",
    },
    onlyBuiltDependencies: ["esbuild"],
  });
});

test("workspaceWithOverrides starts a workspace file when the demo has none", () => {
  assert.deepEqual(parse(workspaceWithOverrides("", { a: "file:/a" }, [])), {
    overrides: { a: "file:/a" },
  });
});
