import assert from "node:assert/strict";
import test from "node:test";

import {
  staleRegistry,
  templateBehindLatest,
  templateCanary,
  templateMembership,
} from "./checks/templates.ts";
import { ago, pull, run } from "./helpers/builders.ts";
import { FakeApi, fixture } from "./helpers/fake-api.ts";
import { child, object, type JsonValue } from "./json.ts";
import type { CheckResult } from "./types.ts";

function keys(result: CheckResult): string[] {
  assert.equal(result.kind, "findings");
  return result.kind === "findings"
    ? result.findings.map(({ key }) => key)
    : [];
}

function packument(withRegistryBin: boolean): JsonValue {
  const base = object(fixture("npm-tooling-configs.json"), "packument");
  const latest = String(child(base, "dist-tags").latest);
  const versions = child(base, "versions");
  const entry = child(versions, latest);
  return {
    ...base,
    versions: {
      ...versions,
      [latest]: {
        ...entry,
        bin: withRegistryBin
          ? { "antelopejs-registry": "./dist/registry.mjs" }
          : {},
      },
    },
  };
}

function dms(range: string, days: number): FakeApi {
  return new FakeApi()
    .org([{ name: "template-module-dms", pack: "template" }])
    .repo("template-module-dms", {
      "package.json": JSON.stringify({
        antelopeJs: { template: { kind: "module" } },
        dependencies: { "@antelopejs/interface-dms": range },
      }),
    })
    .npmPackage("@antelopejs/interface-dms", {
      "dist-tags": { latest: "0.9.0" },
      time: { "0.9.0": ago(days * 24) },
      versions: { "0.9.0": {} },
    });
}

test("a template range that excludes latest is a Finding after 7 days, not before, and not when it admits latest", async () => {
  assert.deepEqual(
    keys(await templateBehindLatest.run(dms(">=0.7.1 <0.8.0", 8).context())),
    ["template-module-dms|template-behind-latest|@antelopejs/interface-dms"],
  );
  assert.deepEqual(
    keys(await templateBehindLatest.run(dms(">=0.7.1 <0.8.0", 6).context())),
    [],
  );
  assert.deepEqual(
    keys(await templateBehindLatest.run(dms(">=0.7.1 <1.0.0", 30).context())),
    [],
  );
});

test("the behind-latest check is skipped while no template declares antelopeJs.template", async () => {
  const api = new FakeApi()
    .org([{ name: "template-module-dms", pack: "template" }])
    .repo("template-module-dms", {
      "package.json": JSON.stringify({ dependencies: {} }),
    });
  assert.equal((await templateBehindLatest.run(api.context())).kind, "skipped");
});

const MANIFEST = JSON.stringify({
  templates: [
    {
      repository: "https://github.com/AntelopeJS/template-blank-typescript.git",
    },
    { repository: "https://github.com/AntelopeJS/template-old.git" },
  ],
  projectTemplates: [],
});

function registry(withBin: boolean): FakeApi {
  return new FakeApi()
    .org([
      { name: "template-blank-typescript", pack: "template" },
      { name: "template-dms-adonis", pack: "template" },
      { name: "template-old", pack: "none", archived: true },
      { name: "interfaces", pack: "none" },
    ])
    .npmPackage("@antelopejs/tooling-configs", packument(withBin))
    .file("/repos/AntelopeJS/interfaces/contents/manifest.json", MANIFEST);
}

test("membership and the stale Registry are skipped until the registry bin is released", async () => {
  const api = registry(false);
  assert.equal((await templateMembership.run(api.context())).kind, "skipped");
  assert.equal((await staleRegistry.run(api.context())).kind, "skipped");
});

test("a template missing from the Registry and an entry pointing at an archived repository are Findings", async () => {
  assert.deepEqual(
    keys(await templateMembership.run(registry(true).context())),
    [
      "template-dms-adonis|template-membership|missing",
      "interfaces|template-membership|archived:template-old",
    ],
  );
});

function stale(differs: boolean, pulls: JsonValue[]): FakeApi {
  const api = registry(true)
    .repo("interfaces", { "manifest.json": MANIFEST })
    .route("/repos/AntelopeJS/interfaces/pulls", pulls);
  api.registryDrift = differs;
  return api;
}

test("a Registry that differs is stale with no PR or a PR older than 24 hours, and fresh with a younger PR or no difference", async () => {
  assert.deepEqual(keys(await staleRegistry.run(stale(true, []).context())), [
    "interfaces|stale-registry|manifests",
  ]);
  assert.deepEqual(
    keys(
      await staleRegistry.run(
        stale(true, [
          pull(3, "chore: regenerate Registry", "github-actions[bot]", 30),
        ]).context(),
      ),
    ),
    ["interfaces|stale-registry|manifests"],
  );
  assert.deepEqual(
    keys(
      await staleRegistry.run(
        stale(true, [
          pull(3, "chore: regenerate Registry", "github-actions[bot]", 5),
        ]).context(),
      ),
    ),
    [],
  );
  assert.deepEqual(
    keys(await staleRegistry.run(stale(false, []).context())),
    [],
  );
});

test("the canary is skipped without the workflow and a Finding when its latest run is red", async () => {
  const none = new FakeApi().org([
    { name: "template-dms-demo", pack: "template" },
  ]);
  assert.equal((await templateCanary.run(none.context())).kind, "skipped");
  const red = new FakeApi()
    .org([{ name: "template-dms-demo", pack: "template" }])
    .route(
      "/repos/AntelopeJS/template-dms-demo/actions/workflows/template-canary.yml/runs",
      { workflow_runs: [run(1, "failure", 2)] },
    );
  assert.deepEqual(keys(await templateCanary.run(red.context())), [
    "template-dms-demo|template-canary|canary",
  ]);
});
