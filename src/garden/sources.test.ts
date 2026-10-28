import assert from "node:assert/strict";
import test from "node:test";

import { linkRot, mutation } from "./checks/artifacts.ts";
import { captureScenes, webBuild } from "./checks/pipelines.ts";
import { run } from "./helpers/builders.ts";
import { FakeApi, zip } from "./helpers/fake-api.ts";
import type { CheckResult } from "./types.ts";

const WORKFLOW = "/repos/AntelopeJS/.github/contents/.github/workflows";

function keys(result: CheckResult): string[] {
  assert.equal(result.kind, "findings");
  return result.kind === "findings"
    ? result.findings.map(({ key }) => key)
    : [];
}

function artifact(repo: string, name: string, content: string): FakeApi {
  return new FakeApi()
    .route(`/repos/AntelopeJS/${repo}/actions/artifacts`, {
      artifacts: [
        {
          id: 9,
          name,
          created_at: "2026-10-27T00:00:00Z",
          expired: false,
          workflow_run: { id: 5 },
        },
      ],
    })
    .archive(
      `/repos/AntelopeJS/${repo}/actions/artifacts/9/zip`,
      zip(`${name}.json`, content),
    );
}

const STRYKER = JSON.stringify({
  files: {
    "src/a.ts": {
      mutants: [
        { status: "Survived" },
        { status: "Survived" },
        { status: "Killed" },
      ],
    },
    "src/b.ts": { mutants: [{ status: "Killed" }] },
  },
});

test("mutation is skipped until G1's workflow exists, then until one report exists", async () => {
  const none = new FakeApi().org([{ name: "mongodb" }]);
  assert.deepEqual(await mutation.run(none.context()), {
    kind: "skipped",
    reason: "AntelopeJS/.github has no mutation.yml yet",
  });
  const early = new FakeApi()
    .org([{ name: "mongodb" }])
    .route(`${WORKFLOW}/mutation.yml`, {})
    .route("/repos/AntelopeJS/mongodb/actions/artifacts", { artifacts: [] });
  const result = await mutation.run(early.context());
  assert.equal(result.kind, "skipped");
});

test("one Finding per repository and source file with a surviving mutant, none for fully killed files", async () => {
  const api = artifact("mongodb", "mutation-report", STRYKER)
    .org([{ name: "mongodb" }, { name: "cdn", tier: "N3" }])
    .route(`${WORKFLOW}/mutation.yml`, {});
  assert.deepEqual(keys(await mutation.run(api.context())), [
    "mongodb|mutation|src/a.ts",
  ]);
  assert.equal(
    api.requests.some((path) => path.includes("/cdn/")),
    false,
  );
});

test("link rot is skipped until the artifact exists, then reports one Finding per repository and file", async () => {
  const missing = new FakeApi()
    .route(`${WORKFLOW}/link-rot.yml`, {})
    .route("/repos/AntelopeJS/.github/actions/artifacts", { artifacts: [] });
  assert.equal((await linkRot.run(missing.context())).kind, "skipped");
  const report = JSON.stringify({
    generatedAt: "2026-10-27T04:00:00Z",
    repos: {
      mongodb: {
        "README.md": [{ url: "https://dead.example", status: "404" }],
        "docs/a.md": [],
      },
    },
  });
  const api = artifact(".github", "link-rot", report).route(
    `${WORKFLOW}/link-rot.yml`,
    {},
  );
  assert.deepEqual(keys(await linkRot.run(api.context())), [
    "mongodb|link-rot|README.md",
  ]);
});

function scenes(conclusion: string, notes: string[]): FakeApi {
  return new FakeApi()
    .org([{ name: "dms", tier: "N2", branch: "main" }])
    .route("/repos/AntelopeJS/dms/actions/workflows/docs-captures.yml/runs", {
      workflow_runs: [run(4, conclusion, 3)],
    })
    .route("/repos/AntelopeJS/dms/actions/runs/4/jobs", { jobs: [{ id: 77 }] })
    .route(
      "/repos/AntelopeJS/dms/check-runs/77/annotations",
      notes.map((message) => ({ message })),
    );
}

test("a failed docs-captures run yields one Finding per scene id named in its annotations", async () => {
  const api = scenes("failure", [
    "scene dashboard-home: selector missing",
    "Scene: billing.invoice failed",
    "scene dashboard-home: again",
  ]);
  assert.deepEqual(keys(await captureScenes.run(api.context())), [
    "dms|capture-scenes|billing.invoice",
    "dms|capture-scenes|dashboard-home",
  ]);
  assert.deepEqual(
    keys(await captureScenes.run(scenes("success", []).context())),
    [],
  );
});

test("captures are skipped while no repository has the workflow", async () => {
  const api = new FakeApi().org([{ name: "dms", tier: "N2" }]);
  assert.deepEqual(await captureScenes.run(api.context()), {
    kind: "skipped",
    reason: "no repository runs docs-captures.yml yet",
  });
});

function web(workflow: string, runs: ReturnType<typeof run>[]): FakeApi {
  return new FakeApi()
    .org([{ name: "antelope-web", tier: "N3" }])
    .repo("antelope-web", { ".github/workflows/build.yml": workflow })
    .route("/repos/AntelopeJS/antelope-web/actions/workflows/build.yml/runs", {
      workflow_runs: runs,
    });
}

test("the antelope-web scheduled build is a Finding only after 24 hours red, and skipped when nothing is scheduled", async () => {
  const scheduled = "on:\n  schedule:\n    - cron: '0 3 * * *'\n";
  assert.deepEqual(
    keys(await webBuild.run(web(scheduled, [run(2, "failure", 30)]).context())),
    ["antelope-web|antelope-web-build|.github/workflows/build.yml"],
  );
  assert.deepEqual(
    keys(await webBuild.run(web(scheduled, [run(2, "failure", 20)]).context())),
    [],
  );
  assert.equal(
    (await webBuild.run(web("on: push\n", []).context())).kind,
    "skipped",
  );
});
