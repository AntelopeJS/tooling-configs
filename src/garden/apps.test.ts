import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readSecretSurface } from "./api.ts";
import { aiApps, orbSecrets } from "./checks/apps.ts";
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
  ["amp-for-github", "all"],
  ["claude", "all"],
  ["chatgpt-codex-connector", "all"],
  ["renovate", "selected"],
);

test("the recorded baseline on both organizations raises nothing except amp-for-github on every Altab repository", async () => {
  const api = new FakeApi()
    .route("/orgs/AntelopeJS/installations", BASELINE)
    .route(
      "/orgs/Altab-S-R-L/installations",
      fixture("installations-altab.json"),
    );
  assert.deepEqual(keys(await aiApps.run(api.context())), [
    "Altab-S-R-L|ai-apps|selected:amp-for-github",
  ]);
});

test("an app on all repositories outside the baseline and Cursor's app on either organization are findings", async () => {
  const api = new FakeApi()
    .route(
      "/orgs/AntelopeJS/installations",
      installed(
        ["claude", "all"],
        ["gitguardian", "all"],
        ["render", "selected"],
        ["cursor", "selected"],
      ),
    )
    .route(
      "/orgs/Altab-S-R-L/installations",
      installed(["amp-for-github", "selected"], ["cursor-agent", "all"]),
    );
  assert.deepEqual(keys(await aiApps.run(api.context())), [
    "AntelopeJS|ai-apps|app:gitguardian",
    "AntelopeJS|ai-apps|cursor:cursor",
    "Altab-S-R-L|ai-apps|cursor:cursor-agent",
    "Altab-S-R-L|ai-apps|app:cursor-agent",
  ]);
});

test("a token the API refuses to list stops the check instead of reporting a clean organization", async () => {
  await assert.rejects(aiApps.run(new FakeApi().context()), /HTTP 404/);
});

test("every credential variable and file the scanner can see is a finding, by name and never by value", async () => {
  const api = new FakeApi();
  api.secretSurface = {
    variables: ["AWS_SECRET_ACCESS_KEY"],
    files: [".aws/credentials"],
  };
  const result = await orbSecrets.run(api.context());
  assert.deepEqual(keys(result), [
    "AntelopeJS|orb-secrets|env:AWS_SECRET_ACCESS_KEY",
    "AntelopeJS|orb-secrets|file:.aws/credentials",
  ]);
  assert.equal(JSON.stringify(result).includes("hunter2"), false);
});

test("the minted GitHub token is allowed and other token-like variables are not", () => {
  const home = mkdtempSync(join(tmpdir(), "garden-home-"));
  try {
    mkdirSync(join(home, ".aws"));
    writeFileSync(join(home, ".aws/credentials"), "x");
    writeFileSync(
      join(home, ".npmrc"),
      "//registry.npmjs.org/:_authToken=abc\n",
    );
    const surface = readSecretSurface(
      ["GH_TOKEN", "GITHUB_TOKEN", "PATH", "NPM_TOKEN", "DB_PASSWORD"],
      home,
    );
    assert.deepEqual(surface.variables, ["DB_PASSWORD", "NPM_TOKEN"]);
    assert.deepEqual(surface.files, [".aws/credentials", ".npmrc"]);
    writeFileSync(
      join(home, ".npmrc"),
      "registry=https://registry.npmjs.org/\n",
    );
    assert.deepEqual(readSecretSurface([], home).files, [".aws/credentials"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
