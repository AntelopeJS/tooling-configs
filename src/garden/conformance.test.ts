import assert from "node:assert/strict";
import test from "node:test";

import { conformance } from "./checks/conformance.ts";
import { ApiError } from "./api.ts";
import { CALLER, LOCK, checkRun, pull, run } from "./helpers/builders.ts";
import { FakeApi, fixture } from "./helpers/fake-api.ts";
import type { CheckResult } from "./types.ts";

const RENOVATE = '{ "extends": ["github>AntelopeJS/.github:renovate.json5"] }';
const PACKAGE = JSON.stringify({
  devDependencies: { "@antelopejs/tooling-configs": "^0.2.7" },
});

function conformant(api: FakeApi, name = "mongodb"): FakeApi {
  return api
    .repo(name, {
      ".github/workflows/ci.yml": CALLER,
      "renovate.json": RENOVATE,
      "package.json": PACKAGE,
      "pnpm-lock.yaml": LOCK("0.2.7"),
    })
    .ci(name, [run(1, "success", 2)], [checkRun("ci / checks", "success")])
    .route(`/repos/AntelopeJS/${name}/pulls`, []);
}

function world(): FakeApi {
  const api = new FakeApi();
  api.npmPackage(
    "@antelopejs/tooling-configs",
    fixture("npm-tooling-configs.json"),
  );
  api.route("/search/issues", {
    items: [
      { repository_url: "https://api.github.com/repos/AntelopeJS/mongodb" },
    ],
  });
  return api.org([{ name: "mongodb" }]);
}

function subjects(result: CheckResult): string[] {
  assert.equal(result.kind, "findings");
  return result.kind === "findings"
    ? result.findings.map(({ subject }) => subject)
    : [];
}

test("a repository on the shared CI, the preset, the latest pack and a green ci / checks has no finding", async () => {
  const api = conformant(world());
  assert.deepEqual(subjects(await conformance.run(api.context())), []);
});

test("a caller job not named ci is reported even though the file calls ci-node.yml@v1", async () => {
  const api = conformant(world()).repo("mongodb", {
    ".github/workflows/ci.yml": CALLER.replace("  ci:", "  checks:"),
    "renovate.json": RENOVATE,
    "package.json": PACKAGE,
    "pnpm-lock.yaml": LOCK("0.2.7"),
  });
  assert.deepEqual(subjects(await conformance.run(api.context())), [
    "ci-job-id",
  ]);
});

test("a caller pinned to another ref or missing is a ci-caller finding", async () => {
  const pinned = conformant(world()).repo("mongodb", {
    ".github/workflows/ci.yml": CALLER.replace("@v1", "@main"),
    "renovate.json": RENOVATE,
    "package.json": PACKAGE,
    "pnpm-lock.yaml": LOCK("0.2.7"),
  });
  assert.ok(
    subjects(await conformance.run(pinned.context())).includes("ci-caller"),
  );
  const inline = conformant(world()).repo("mongodb", {
    ".github/workflows/ci.yml":
      "name: ci\non: push\njobs:\n  checks:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm run checks\n",
    "renovate.json": RENOVATE,
    "package.json": PACKAGE,
    "pnpm-lock.yaml": LOCK("0.2.7"),
  });
  assert.ok(
    subjects(await conformance.run(inline.context())).includes("ci-caller"),
  );
});

test("a Renovate file that does not extend the preset is reported, one that does is not", async () => {
  const api = conformant(world()).repo("mongodb", {
    ".github/workflows/ci.yml": CALLER,
    "renovate.json": '{ "extends": ["config:recommended"] }',
    "package.json": PACKAGE,
    "pnpm-lock.yaml": LOCK("0.2.7"),
  });
  assert.deepEqual(subjects(await conformance.run(api.context())), [
    "renovate-config",
  ]);
});

test("the locked version decides currency, and a Renovate PR under 7 days old excuses a stale pack, one of 8 days does not", async () => {
  const stale = (pulls: ReturnType<typeof pull>[]) =>
    conformant(world())
      .repo("mongodb", {
        ".github/workflows/ci.yml": CALLER,
        "renovate.json": RENOVATE,
        "package.json": PACKAGE,
        "pnpm-lock.yaml": LOCK("0.2.5"),
      })
      .route("/repos/AntelopeJS/mongodb/pulls", pulls);
  const bump = (hours: number) =>
    pull(
      7,
      "chore(deps): update @antelopejs/tooling-configs to v0.2.7",
      "renovate[bot]",
      hours,
    );
  assert.deepEqual(subjects(await conformance.run(stale([]).context())), [
    "tooling-configs",
  ]);
  assert.deepEqual(
    subjects(await conformance.run(stale([bump(24 * 6)]).context())),
    [],
  );
  assert.deepEqual(
    subjects(await conformance.run(stale([bump(24 * 8)]).context())),
    ["tooling-configs"],
  );
});

test("a red ci / checks on the newest push and a repository still reporting the legacy context are told apart", async () => {
  const red = conformant(world()).ci(
    "mongodb",
    [run(1, "failure", 2)],
    [checkRun("ci / checks", "failure")],
  );
  assert.deepEqual(subjects(await conformance.run(red.context())), [
    "checks-red",
  ]);
  const legacy = conformant(world()).ci(
    "mongodb",
    [run(1, "success", 2)],
    [checkRun("checks", "success")],
  );
  assert.deepEqual(subjects(await conformance.run(legacy.context())), [
    "checks-context",
  ]);
});

test("the ratchet file is reported only when the history deleted it before it came back", async () => {
  const files = {
    ".github/workflows/ci.yml": CALLER,
    "renovate.json": RENOVATE,
    "package.json": PACKAGE,
    "pnpm-lock.yaml": LOCK("0.2.7"),
    "guardrails.ratchet.json": "{}",
  };
  const history = (status: string) =>
    conformant(world())
      .repo("mongodb", files)
      .route("/repos/AntelopeJS/mongodb/commits", [{ sha: "abc" }])
      .route("/repos/AntelopeJS/mongodb/commits/abc", {
        files: [{ filename: "guardrails.ratchet.json", status }],
      });
  assert.deepEqual(
    subjects(await conformance.run(history("removed").context())),
    ["ratchet"],
  );
  assert.deepEqual(
    subjects(await conformance.run(history("modified").context())),
    [],
  );
});

test("a TypeScript repository without the pack is new, an N4 one and a non-TypeScript one are not", async () => {
  const api = conformant(world()).org([
    { name: "mongodb" },
    { name: "cloud", pack: "none", tier: "N3" },
    { name: "cloud-pricing-app", pack: "none", tier: "N4" },
    { name: "interfaces", pack: "none", tier: "N1", language: "JSON" },
  ]);
  const result = await conformance.run(api.context());
  assert.equal(result.kind, "findings");
  const created =
    result.kind === "findings"
      ? result.findings.filter(({ subject }) => subject === "new")
      : [];
  assert.deepEqual(
    created.map(({ repo }) => repo),
    ["cloud"],
  );
});

test("the Mend selection flags repositories without Renovate activity, except k8s-gitops-infra and N4", async () => {
  const api = conformant(conformant(world()), "redis").org([
    { name: "mongodb" },
    { name: "redis", tier: "N1" },
    { name: "k8s-gitops-infra", pack: "none", tier: "N3", language: "Python" },
    { name: "datatable-new", pack: "none", tier: "N4" },
  ]);
  const result = await conformance.run(api.context());
  const flagged =
    result.kind === "findings"
      ? result.findings.filter(({ subject }) => subject === "renovate-app")
      : [];
  assert.deepEqual(
    flagged.map(({ repo }) => repo),
    ["redis"],
  );
  assert.match(flagged[0].doneMeans, /Antony adds/);
});

test("dms-cicd and cms repositories are never listed and no request names them", async () => {
  const api = conformant(world()).org([
    { name: "mongodb" },
    { name: "dms-cicd" },
    { name: "cms-api", tier: "N3" },
    { name: "cms" },
  ]);
  const repos = await api.context().repos();
  await conformance.run(api.context());
  assert.deepEqual(
    repos.map(({ name }) => name),
    ["mongodb"],
  );
  assert.equal(
    api.requests.some((path) => /dms-cicd|\/cms/.test(path)),
    false,
  );
});

test("a repository whose reads fail does not hide the findings of the others", async () => {
  const api = conformant(world()).org([{ name: "mongodb" }, { name: "redis" }]);
  api.route(
    "/repos/AntelopeJS/redis/git/trees/main",
    new ApiError(500, "boom"),
  );
  await assert.rejects(conformance.run(api.context()), /redis: boom/);
});
