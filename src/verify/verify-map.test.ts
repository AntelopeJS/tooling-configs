import { execFileSync } from "node:child_process";
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
    data: { globs: ["src/store/**"], funnels: ["src/store/delete.ts"], why: "rows" },
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
  commit(root);
  const gaps = verify(root, tmp, ["map"]);
  assert.equal(gaps.status, 1);
  assert.deepEqual(
    gaps.stdout.trim().split("\n").sort(),
    [
      "unmapped: src/store/delete.ts matches no feature glob",
      ".agents/skills/verify-module/features/core.md: docs path docs/missing.md does not exist",
      ".agents/skills/verify-module/features/core.md: journey ghost is neither built in nor in verify.config.ts journeys",
      "verify.config.ts journey own is in no feature file",
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

const SPLIT = {
  [`${SKILL}/features/core.md`]: feature(
    ["src/index.ts"],
    ["module-dev", "own"],
  ),
  [`${SKILL}/features/store.md`]: feature(["src/store/**"], ["module-dev"]),
};

function configWithShared(shared: string) {
  return {
    ...SPLIT,
    [`${SKILL}/verify.config.ts`]: `export default { doors: ${DOORS}, shared: ${shared}, journeys: { own: { title: "", entryPoint: "", async run() {} } } };\n`,
  };
}

function planOf(root: string, tmp: string, args: string[] = []) {
  const result = verify(root, tmp, ["plan", ...args]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("a diff touching only package.json plans every feature and names the shared file, where a covers-only plan runs smoke alone", (t) => {
  const { root, tmp } = mapRepo(t, SPLIT);
  put(
    root,
    "package.json",
    '{"name":"guardrails-test","type":"module","version":"2.0.0"}\n',
  );
  const plan = planOf(root, tmp);
  assert.deepEqual(plan.run, ["smoke", "core", "store"]);
  assert.deepEqual(plan.full, { reason: "shared", files: ["package.json"] });
  assert.deepEqual(plan.touched, []);
  assert.deepEqual(plan.docs, ["README.md"]);
});

test("a module's interfaces and antelope lock are shared, where a list of root manifests alone runs one feature on an interface change", (t) => {
  const { root, tmp } = mapRepo(t, SPLIT);
  put(root, "src/interfaces/demo/beta/index.ts", "export {};\n");
  put(root, "antelope-lock/demo@1.0.0/pnpm-lock.yaml", "lockfileVersion: 9\n");
  const plan = JSON.parse(verify(root, tmp, ["plan"]).stdout);
  assert.deepEqual(plan.run, ["smoke", "core", "store"]);
  assert.deepEqual(plan.full, {
    reason: "shared",
    files: [
      "antelope-lock/demo@1.0.0/pnpm-lock.yaml",
      "src/interfaces/demo/beta/index.ts",
    ],
  });
});

test("a single-interface module's src/interface is shared too, where a default naming only src/interfaces runs smoke alone on its interface change", (t) => {
  const { root, tmp } = mapRepo(t, SPLIT);
  put(root, "src/interface/index.ts", "export const api = 2;\n");
  const plan = JSON.parse(verify(root, tmp, ["plan"]).stdout);
  assert.deepEqual(plan.run, ["smoke", "core", "store"]);
  assert.deepEqual(plan.full, {
    reason: "shared",
    files: ["src/interface/index.ts"],
  });
});

test("a diff touching only a covered source file plans that feature and smoke, never the rest, where an always-full plan runs every feature", (t) => {
  const { root, tmp } = mapRepo(t, SPLIT);
  put(root, "src/index.ts", "export const one = 2;\n");
  const plan = planOf(root, tmp);
  assert.deepEqual(plan.run, ["smoke", "core"]);
  assert.equal(plan.full, null);
});

test("plan --all runs every feature whatever the diff, and says so", (t) => {
  const { root, tmp } = mapRepo(t, SPLIT);
  const plan = planOf(root, tmp, ["--all"]);
  assert.deepEqual(plan.run, ["smoke", "core", "store"]);
  assert.deepEqual(plan.full, { reason: "all" });
});

test("shared in verify.config.ts replaces the default list, where a merged list still runs everything on package.json", (t) => {
  const { root, tmp } = mapRepo(t, configWithShared('["config/**"]'));
  put(
    root,
    "package.json",
    '{"name":"guardrails-test","type":"module","version":"2.0.0"}\n',
  );
  const bumped = planOf(root, tmp);
  assert.deepEqual(bumped.run, ["smoke"]);
  assert.equal(bumped.full, null);
  put(root, "config/app.json", "{}\n");
  const configured = planOf(root, tmp);
  assert.deepEqual(configured.run, ["smoke", "core", "store"]);
  assert.deepEqual(configured.full, {
    reason: "shared",
    files: ["config/app.json"],
  });
});

test("a shared glob never pulls in the verification layer, where a glob match alone would run everything on a skill edit", (t) => {
  const { root, tmp } = mapRepo(t, configWithShared('["**/*.yml", "**/*.md"]'));
  put(root, ".github/workflows/ci.yml", "jobs: {}\n");
  put(root, `${SKILL}/SKILL.md`, "edited\n");
  assert.equal(planOf(root, tmp).full, null);
  put(root, "deploy.yml", "a: 1\n");
  assert.deepEqual(planOf(root, tmp).full, {
    reason: "shared",
    files: ["deploy.yml"],
  });
});

test("doors flags a declared funnel, adds no default glob for a kind set to null", (t) => {
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
    assert.deepEqual(
      [...new Set(lines.map((line) => line.split(" ")[3]))].sort(),
      [
        "clean",
        "doctor",
        "journey",
        "map",
        "new",
        "plan",
        "publish",
        "verdict",
      ],
      `${kind} shows its commands`,
    );
    for (const line of lines)
      assert.match(
        line,
        /^pnpm exec antelopejs-verify [a-z-]+( [^|;&$`]*)?$/,
        `${kind}: ${line}`,
      );
  }
});

test("moving a shared file away still counts its old path, where rename detection hides the source and runs one feature", (t) => {
  const { root, tmp } = mapRepo(t, {
    ...SPLIT,
    "src/interfaces/demo/beta/index.ts": "export const api = 1;\n",
  });
  execFileSync(
    "git",
    ["mv", "src/interfaces/demo/beta/index.ts", "src/store/api.ts"],
    { cwd: root },
  );
  const plan = JSON.parse(verify(root, tmp, ["plan"]).stdout);
  assert.deepEqual(plan.full, {
    reason: "shared",
    files: ["src/interfaces/demo/beta/index.ts"],
  });
  assert.deepEqual(plan.run, ["smoke", "core", "store"]);
});
