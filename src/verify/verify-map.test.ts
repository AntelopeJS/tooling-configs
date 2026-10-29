import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { commit, put } from "../guardrails/helpers/test-repo.ts";
import { feature, verify, verifyRepo } from "./helpers/verify-repo.ts";
import { VERIFY_KINDS } from "./kinds.ts";
import { skillText } from "./skills.ts";

const SKILL = ".agents/skills/verify-module";

const DOORS = `{
    data: { globs: ["src/store/**"], funnels: ["src/store/delete.ts"], containments: ["core/own"], why: "rows" },
    format: null,
    contract: null,
    outbound: null,
    exposure: null,
    publish: null,
  }`;

function mapRepo(t: TestContext, extra: Record<string, string> = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-runs-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "src/index.ts": "export const one = 1;\n",
    "src/store/delete.ts": "export const drop = 1;\n",
    "src/index.test.ts": "export {};\n",
    [`${SKILL}/verify.config.ts`]: `export default { doors: ${DOORS}, journeys: { own: { title: "", entryPoint: "", async run() {} } } };\n`,
    [`${SKILL}/features/smoke.md`]: feature([], ["module-dev"]),
    [`${SKILL}/features/core.md`]: feature(["src/**"], ["module-dev", "own"]),
    [`${SKILL}/seeded-breaks/smoke.patch`]: "patch\n",
    [`${SKILL}/seeded-breaks/core.patch`]: "patch\n",
    [`${SKILL}/seeded-doors/data.patch`]:
      "--- a/src/store/delete.ts\n+++ b/src/store/delete.ts\n",
    ...extra,
  });
  return { root, tmp };
}

test("map is silent on a complete map and names every gap of an incomplete one", (t) => {
  const { root, tmp } = mapRepo(t);
  const complete = verify(root, tmp, ["map"]);
  assert.equal(complete.status, 0, complete.stdout + complete.stderr);
  assert.equal(complete.stdout, "");
  put(
    root,
    `${SKILL}/features/core.md`,
    feature(["src/index.ts"], ["module-dev", "ghost"], ["docs/missing.md"]),
  );
  rmSync(join(root, SKILL, "seeded-doors/data.patch"));
  rmSync(join(root, SKILL, "seeded-breaks/core.patch"));
  commit(root);
  const gaps = verify(root, tmp, ["map"]);
  assert.equal(gaps.status, 1);
  assert.deepEqual(
    gaps.stdout.trim().split("\n").sort(),
    [
      "unmapped: src/store/delete.ts matches no feature glob",
      ".agents/skills/verify-module/features/core.md: docs path docs/missing.md does not exist",
      ".agents/skills/verify-module/features/core.md: journey ghost is neither built in nor in verify.config.ts journeys",
      ".agents/skills/verify-module/features/core.md: seeded-breaks/core.patch is missing",
      "seeded-doors/data.patch is missing: the data door applies to this repository",
      "verify.config.ts journey own is in no feature file",
      "doors.data containment core/own is not a journey a feature registers",
    ].sort(),
  );
});

test("plan runs smoke plus every touched feature and fails on an unmapped user-facing file, never on a test", (t) => {
  const { root, tmp } = mapRepo(t, {
    [`${SKILL}/features/core.md`]: feature(
      ["src/index.ts"],
      ["module-dev", "own"],
    ),
  });
  put(root, "src/index.ts", "export const one = 2;\n");
  put(root, "src/index.test.ts", "export const changed = 1;\n");
  const mapped = verify(root, tmp, ["plan"]);
  assert.equal(mapped.status, 0, mapped.stderr);
  const plan = JSON.parse(mapped.stdout);
  assert.deepEqual(plan.run, ["smoke", "core"]);
  assert.deepEqual(plan.docs, ["README.md"]);
  put(root, "src/store/delete.ts", "export const drop = 2;\n");
  const unmapped = verify(root, tmp, ["plan"]);
  assert.equal(unmapped.status, 1);
  assert.deepEqual(JSON.parse(unmapped.stdout).unmapped, [
    "src/store/delete.ts",
  ]);
});

test("doors flags a declared funnel, adds no default glob for a kind set to null, and seeded-doors reports a patch it does not flag", (t) => {
  const { root, tmp } = mapRepo(t);
  put(root, "src/store/delete.ts", "export const drop = 2;\n");
  put(
    root,
    "package.json",
    '{"name":"guardrails-test","type":"module","version":"1.0.1"}\n',
  );
  const doors = verify(root, tmp, ["doors"]);
  assert.equal(doors.status, 0, doors.stderr);
  assert.equal(
    doors.stdout,
    "One-way-door: data\n  data: src/store/delete.ts\n",
  );
  assert.equal(
    verify(root, tmp, ["seeded-doors"]).stdout,
    "FLAGGED data (path rules flag: data)\n",
  );
  put(
    root,
    `${SKILL}/seeded-doors/data.patch`,
    "--- a/README.md\n+++ b/README.md\n",
  );
  const missed = verify(root, tmp, ["seeded-doors"]);
  assert.equal(missed.status, 1);
  assert.equal(missed.stdout, "MISSED data (path rules flag: nothing)\n");
});

test("the bin names the missing repo-owned layer instead of running without it", (t) => {
  const { root, tmp } = mapRepo(t);
  rmSync(join(root, SKILL, "verify.config.ts"));
  const result = verify(root, tmp, ["map"]);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /verify\.config\.ts is missing\. Write the repo-owned layer/,
  );
});

function commandBlocks(text: string): string[][] {
  return [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) =>
    match[1].trim().split("\n"),
  );
}

test("every shell block of every shared skill is one antelopejs-verify command per line, never a recipe", () => {
  for (const kind of VERIFY_KINDS) {
    const text = skillText(kind);
    assert.match(
      text,
      new RegExp(`^---\\nname: verify-${kind}\\ndescription: "`),
    );
    const lines = commandBlocks(text).flat();
    assert.ok(lines.length >= 10, `${kind} shows its commands`);
    for (const line of lines)
      assert.match(
        line,
        /^pnpm exec antelopejs-verify [a-z-]+( [^|;&$`]*)?$/,
        `${kind}: ${line}`,
      );
  }
});
