import assert from "node:assert/strict";
import test from "node:test";

import { aiApps } from "./checks/apps.ts";
import { FakeApi, fixture } from "./helpers/fake-api.ts";
import type { CheckResult } from "./types.ts";

function installed(...apps: [string, string][]) {
  return {
    installations: apps.map(([app_slug, repository_selection]) => ({
      app_slug,
      repository_selection,
    })),
  };
}

function keys(result: CheckResult): string[] {
  assert.equal(result.kind, "findings");
  return result.kind === "findings"
    ? result.findings.map(({ key }) => key)
    : [];
}

const BASELINE = installed(
  ["claude", "all"],
  ["chatgpt-codex-connector", "all"],
  ["renovate", "selected"],
);

test("the recorded baseline on both organizations raises nothing", async () => {
  const api = new FakeApi()
    .route("/orgs/AntelopeJS/installations", BASELINE)
    .route(
      "/orgs/Altab-S-R-L/installations",
      fixture("installations-altab.json"),
    );
  assert.deepEqual(keys(await aiApps.run(api.context())), []);
});

test("an app on all repositories outside the baseline and Cursor's app on either organization are findings", async () => {
  const api = new FakeApi()
    .route(
      "/orgs/AntelopeJS/installations",
      installed(
        ["claude", "all"],
        ["stray-app", "all"],
        ["render", "selected"],
        ["cursor", "selected"],
      ),
    )
    .route(
      "/orgs/Altab-S-R-L/installations",
      installed(["cursor-agent", "all"]),
    );
  assert.deepEqual(keys(await aiApps.run(api.context())), [
    "AntelopeJS|ai-apps|app:stray-app",
    "AntelopeJS|ai-apps|cursor:cursor",
    "Altab-S-R-L|ai-apps|cursor:cursor-agent",
    "Altab-S-R-L|ai-apps|app:cursor-agent",
  ]);
});

test("gitguardian on all repositories of both organizations raises nothing", async () => {
  const api = new FakeApi()
    .route("/orgs/AntelopeJS/installations", installed(["gitguardian", "all"]))
    .route(
      "/orgs/Altab-S-R-L/installations",
      installed(["gitguardian", "all"]),
    );
  assert.deepEqual(keys(await aiApps.run(api.context())), []);
});

test("pkg-pr-new on all repositories of AntelopeJS raises nothing", async () => {
  const api = new FakeApi()
    .route("/orgs/AntelopeJS/installations", installed(["pkg-pr-new", "all"]))
    .route("/orgs/Altab-S-R-L/installations", installed());
  assert.deepEqual(keys(await aiApps.run(api.context())), []);
});

test("antelopejs-release on all repositories raises nothing while another all-repos app still does", async () => {
  const api = new FakeApi()
    .route(
      "/orgs/AntelopeJS/installations",
      installed(["antelopejs-release", "all"], ["stray-app", "all"]),
    )
    .route("/orgs/Altab-S-R-L/installations", installed());
  assert.deepEqual(keys(await aiApps.run(api.context())), [
    "AntelopeJS|ai-apps|app:stray-app",
  ]);
});

test("renovate on all repositories raises nothing while another all-repos app still does", async () => {
  const api = new FakeApi()
    .route(
      "/orgs/AntelopeJS/installations",
      installed(["renovate", "all"], ["stray-app", "all"]),
    )
    .route("/orgs/Altab-S-R-L/installations", installed());
  assert.deepEqual(keys(await aiApps.run(api.context())), [
    "AntelopeJS|ai-apps|app:stray-app",
  ]);
});

test("a token the API refuses to list stops the check instead of reporting a clean organization", async () => {
  await assert.rejects(aiApps.run(new FakeApi().context()), /HTTP 404/);
});
