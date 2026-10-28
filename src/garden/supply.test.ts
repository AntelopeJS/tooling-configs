import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "./api.ts";
import { advisories, packageSize, stuckRenovate } from "./checks/supply.ts";
import { ago, pull } from "./helpers/builders.ts";
import { FakeApi, fixture } from "./helpers/fake-api.ts";
import type { JsonValue } from "./json.ts";
import type { CheckResult } from "./types.ts";

const PUBLIC = JSON.stringify({ name: "@antelopejs/mongodb" });
const PRIVATE = JSON.stringify({ name: "mongodb", private: true });

function alertOf(
  number: number,
  severity: string,
  scope: string,
  hoursAgo: number,
): JsonValue {
  return {
    number,
    html_url: `https://github.com/AntelopeJS/mongodb/security/dependabot/${number}`,
    created_at: ago(hoursAgo),
    dependency: { scope, package: { name: "undici" } },
    security_advisory: { ghsa_id: `GHSA-${number}`, severity },
  };
}

function world(manifest: string, alerts: JsonValue[]): FakeApi {
  return new FakeApi()
    .org([{ name: "mongodb" }])
    .repo("mongodb", { "package.json": manifest })
    .route("/repos/AntelopeJS/mongodb/dependabot/alerts", alerts);
}

function severities(result: CheckResult): string[] {
  assert.equal(result.kind, "findings");
  return result.kind === "findings"
    ? result.findings.map(({ subject, severity }) => `${subject}:${severity}`)
    : [];
}

test("runtime alerts age out at 7 days, or 48 hours when critical, and development alerts never count", async () => {
  const api = world(PUBLIC, [
    alertOf(1, "critical", "runtime", 49),
    alertOf(2, "critical", "runtime", 40),
    alertOf(3, "high", "runtime", 24 * 8),
    alertOf(4, "high", "runtime", 24 * 6),
    alertOf(5, "critical", "development", 24 * 30),
  ]);
  assert.deepEqual(severities(await advisories.run(api.context())), [
    "GHSA-1:urgent",
    "GHSA-3:normal",
  ]);
});

test("a critical advisory is urgent only in a repository that publishes a package", async () => {
  const api = world(PRIVATE, [alertOf(1, "critical", "runtime", 72)]);
  assert.deepEqual(severities(await advisories.run(api.context())), [
    "GHSA-1:normal",
  ]);
});

test("disabled alerts are quiet but any other denial stops the check", async () => {
  const disabled = world(PUBLIC, []).route(
    "/repos/AntelopeJS/mongodb/dependabot/alerts",
    new ApiError(403, "Dependabot alerts are disabled for this repository."),
  );
  assert.deepEqual(severities(await advisories.run(disabled.context())), []);
  const denied = world(PUBLIC, []).route(
    "/repos/AntelopeJS/mongodb/dependabot/alerts",
    new ApiError(403, "Resource not accessible by integration"),
  );
  await assert.rejects(
    advisories.run(denied.context()),
    /Resource not accessible/,
  );
});

test("the recorded antelopejs alerts give no finding: five are development-only and the one runtime alert is 3 days old", async () => {
  const api = world(PUBLIC, []).route(
    "/repos/AntelopeJS/mongodb/dependabot/alerts",
    fixture("alerts-antelopejs.json"),
  );
  assert.deepEqual(severities(await advisories.run(api.context())), []);
});

test("Renovate, docs captures and Registry regeneration PRs are stuck after 7 days, human PRs never", async () => {
  const api = new FakeApi()
    .org([{ name: "mongodb" }])
    .route("/repos/AntelopeJS/mongodb/pulls", [
      pull(1, "chore(deps): update x", "renovate[bot]", 24 * 8),
      pull(2, "chore(deps): update y", "renovate[bot]", 24 * 6),
      pull(3, "feat: a human change", "Upd4ting", 24 * 30),
      pull(4, "docs captures", "github-actions[bot]", 24 * 9),
      pull(5, "chore: regenerate the Registry", "github-actions[bot]", 24 * 9),
    ]);
  const result = await stuckRenovate.run(api.context());
  assert.deepEqual(severities(result), [
    "pr-1:normal",
    "pr-4:normal",
    "pr-5:normal",
  ]);
});

function packument(next: boolean): JsonValue {
  const dist = (version: string) => ({
    dist: { tarball: `https://registry.npmjs.org/p/-/p-${version}.tgz` },
  });
  return {
    "dist-tags": next
      ? { latest: "1.0.0", next: "1.1.0-next.1" }
      : { latest: "1.1.0" },
    versions: next
      ? { "1.0.0": dist("1.0.0"), "1.1.0-next.1": dist("1.1.0-next.1") }
      : { "1.0.0": dist("1.0.0"), "1.1.0": dist("1.1.0") },
  };
}

function sized(next: boolean, newest: number): FakeApi {
  const newestVersion = next ? "1.1.0-next.1" : "1.1.0";
  return world(PUBLIC, [])
    .npmPackage("@antelopejs/mongodb", packument(next))
    .size("https://registry.npmjs.org/p/-/p-1.0.0.tgz", 1000)
    .size(`https://registry.npmjs.org/p/-/p-${newestVersion}.tgz`, newest);
}

test("the newest next tarball more than 20% over latest is a finding, 20% exactly is not", async () => {
  assert.deepEqual(
    severities(await packageSize.run(sized(true, 1201).context())),
    ["@antelopejs/mongodb:normal"],
  );
  assert.deepEqual(
    severities(await packageSize.run(sized(true, 1200).context())),
    [],
  );
});

test("without a next tag the two newest versions are compared", async () => {
  assert.deepEqual(
    severities(await packageSize.run(sized(false, 1500).context())),
    ["@antelopejs/mongodb:normal"],
  );
  assert.deepEqual(
    severities(await packageSize.run(sized(false, 900).context())),
    [],
  );
});

test("an unpublished package is not measured", async () => {
  const api = world(PRIVATE, []).npmPackage("mongodb", packument(true));
  assert.deepEqual(severities(await packageSize.run(api.context())), []);
});
