import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { feature, verify, verifyRepo } from "./helpers/verify-repo.ts";
import { judgeContainment } from "./containments.ts";
import type { JourneyResult } from "./results.ts";

const SKILL = ".agents/skills/verify-module";

const LOCK =
  "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n";

const DOOR_PATCH = `--- a/src/store.ts
+++ b/src/store.ts
@@ -1 +1 @@
-export const store = 1;
+export const store = 2;
`;

function reading(id: string, read: boolean): string {
  return `${JSON.stringify(id)}: {
      title: "${id} reads the store",
      entryPoint: "node",
      async run(context) {
        const result = await context.command("read store", process.execPath, ["-e", ${read ? "\"process.stdout.write(require('node:fs').readFileSync('src/store.ts', 'utf8'))\"" : "\"process.stdout.write('unrelated')\""}], { cwd: context.repo });
        context.expect(result.folder, [
          { name: "the store holds 1", pass: ${read ? "result.stdout.includes('store = 1')" : "true"}, detail: result.stdout.trim() },
        ]);
      },
    }`;
}

function containmentRepo(t: TestContext, containment: string, kind = "data") {
  const tmp = mkdtempSync(join(tmpdir(), "verify-runs-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const doors = (key: string) =>
    key === kind
      ? `{ globs: ["src/store.ts"], funnels: [], containments: ["store/${containment}"], why: "rows" }`
      : "null";
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "package.json": '{"name":"demo","type":"module","version":"1.0.0"}\n',
    "pnpm-lock.yaml": LOCK,
    "src/store.ts": "export const store = 1;\n",
    [`${SKILL}/verify.config.ts`]: `export default {
  doors: { data: ${doors("data")}, format: ${doors("format")}, contract: null, outbound: null, exposure: null, publish: null },
  setup: [["node", "-e", "0"]],
  journeys: { ${reading("catches", true)}, ${reading("blind", false)} },
};
`,
    [`${SKILL}/features/smoke.md`]: feature([], ["catches"]),
    [`${SKILL}/features/store.md`]: feature(["src/**"], ["catches", "blind"]),
    [`${SKILL}/seeded-breaks/smoke.patch`]: "x\n",
    [`${SKILL}/seeded-breaks/store.patch`]: "x\n",
    [`${SKILL}/seeded-doors/${kind}.patch`]: DOOR_PATCH,
  });
  return { root, tmp };
}

test("containments passes a containment that fails with its door and passes unpatched", (t) => {
  const { root, tmp } = containmentRepo(t, "catches");
  const result = verify(root, tmp, ["containments"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /^CONTAINED data store\/catches: it passes unpatched and fails a check with its door/,
  );
  const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(worktrees.match(/^worktree /gm)?.length, 1, worktrees);
});

test("containments fails a containment that still passes with its door applied", (t) => {
  const { root, tmp } = containmentRepo(t, "blind", "format");
  const result = verify(root, tmp, ["containments"]);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /^MISSED format store\/blind: it passes with its seeded door applied/,
  );
});

test("containments fails a Data door that has no seeded door patch", (t) => {
  const { root, tmp } = containmentRepo(t, "catches");
  execFileSync("git", ["rm", "-q", `${SKILL}/seeded-doors/data.patch`], {
    cwd: root,
  });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "commit",
      "-qm",
      "x",
    ],
    { cwd: root },
  );
  const result = verify(root, tmp, ["containments"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^NO-DOOR data store\/catches: /);
});

test("containments passes and prints nothing on a repository with no Data or Format door", (t) => {
  const { root, tmp } = containmentRepo(t, "catches", "contract");
  const result = verify(root, tmp, ["containments"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
});

function result(
  status: JourneyResult["status"],
  failing: boolean,
): JourneyResult {
  return {
    feature: "f",
    journey: "j",
    title: "",
    entryPoint: "",
    status,
    steps: [
      {
        name: "s",
        folder: "",
        checks: [{ name: "c", pass: !failing, detail: "" }],
      },
    ],
    error: null,
    notVerified: null,
    folder: "",
  };
}

test("a containment is proven only by a control pass followed by a failing check with the door", () => {
  const pass = result("PASS", false);
  const caught = result("FAIL", true);
  assert.equal(judgeContainment(pass, caught).outcome, "CONTAINED");
  assert.equal(judgeContainment(pass, pass).outcome, "MISSED");
  assert.equal(judgeContainment(caught, caught).outcome, "UNPROVEN");
  assert.equal(
    judgeContainment(pass, result("FAIL", false)).outcome,
    "UNPROVEN",
  );
  const unreached = judgeContainment(pass, {
    ...result("NOT VERIFIED", true),
    notVerified: "the service went away",
  });
  assert.equal(unreached.outcome, "UNPROVEN");
  assert.match(
    unreached.detail,
    /could not reach the product \(the service went away\)/,
  );
  assert.equal(judgeContainment(undefined, caught).outcome, "UNPROVEN");
});

test("map still fails a Data door whose containment is missing", (t) => {
  const { root, tmp } = containmentRepo(t, "ghost");
  const result = verify(root, tmp, ["map"]);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /doors\.data containment store\/ghost is not a journey a feature registers/,
  );
});
