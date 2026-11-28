import assert from "node:assert/strict";
import test from "node:test";

import { matrixRunsOn, RUNS_ON, runsOnFor } from "./ci-hand-jobs.ts";
import { CI_PATH } from "./ci-workflow.ts";
import { jobsOf, syncCi, workflowWith } from "./helpers/ci-text.ts";

const LINUX =
  "${{ vars.RUNNER_CI || (github.event.repository.visibility == 'public' && 'ubuntu-latest' || 'blacksmith-4vcpu-ubuntu-2404') }}";
const WINDOWS =
  "${{ vars.RUNNER_CI_WINDOWS || (github.event.repository.visibility == 'public' && 'windows-latest' || 'blacksmith-4vcpu-windows-2025') }}";
const MATRIX =
  "${{ matrix.os == 'windows-latest' && (vars.RUNNER_CI_WINDOWS || (github.event.repository.visibility == 'public' && 'windows-latest' || 'blacksmith-4vcpu-windows-2025')) || (vars.RUNNER_CI || (github.event.repository.visibility == 'public' && 'ubuntu-latest' || 'blacksmith-4vcpu-ubuntu-2404')) }}";

function runnerOf(runsOn: string): string | undefined {
  const text = syncCi(
    workflowWith(
      `  lint:\n    runs-on: ${runsOn}\n    steps:\n      - run: pnpm lint\n`,
    ),
  ).content;
  return jobsOf(text).lint["runs-on"];
}

/**
 * The label GitHub resolves a runs-on expression to, for the expressions sync writes: `vars` and the event's visibility
 * substituted, `||` and `&&` with GitHub's falsy empty string and null.
 */
function resolve(
  expression: string,
  {
    visibility,
    vars = {},
    os,
  }: { visibility?: string; vars?: Record<string, string>; os?: string },
): string {
  const body = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  const js = body
    .replace(/vars\.(\w+)/g, (_m, name: string) =>
      JSON.stringify(vars[name] ?? ""),
    )
    .replace(
      /github\.event\.repository\.visibility/g,
      JSON.stringify(visibility ?? null),
    )
    .replace(/matrix\.os/g, JSON.stringify(os ?? ""))
    .replaceAll("'", '"');
  return String(new Function(`return (${js});`)());
}

test("the Linux and Windows expressions are the shared workflows' shape, so a sync that writes a literal label or another variable fails", () => {
  assert.equal(RUNS_ON.linux, LINUX);
  assert.equal(RUNS_ON.windows, WINDOWS);
  assert.equal(matrixRunsOn("windows-latest"), MATRIX);
});

test("each expression picks GitHub's runner for a public repository, Blacksmith for a private or internal one or an event without the visibility, and the variable when set, so an expression that lands on an empty label or ignores the override fails", () => {
  for (const [expression, os, pub, priv, variable] of [
    [
      LINUX,
      "ubuntu-latest",
      "ubuntu-latest",
      "blacksmith-4vcpu-ubuntu-2404",
      "RUNNER_CI",
    ],
    [
      WINDOWS,
      "windows-latest",
      "windows-latest",
      "blacksmith-4vcpu-windows-2025",
      "RUNNER_CI_WINDOWS",
    ],
    [
      MATRIX,
      "ubuntu-latest",
      "ubuntu-latest",
      "blacksmith-4vcpu-ubuntu-2404",
      "RUNNER_CI",
    ],
    [
      MATRIX,
      "windows-latest",
      "windows-latest",
      "blacksmith-4vcpu-windows-2025",
      "RUNNER_CI_WINDOWS",
    ],
  ] as const) {
    assert.equal(
      resolve(expression, { visibility: "public", os }),
      pub,
      `${os} public`,
    );
    for (const visibility of ["private", "internal", undefined])
      assert.equal(
        resolve(expression, { visibility, os }),
        priv,
        `${os} ${visibility}`,
      );
    assert.equal(
      resolve(expression, {
        visibility: "public",
        os,
        vars: { [variable]: "own-runner" },
      }),
      "own-runner",
      `${os} override`,
    );
  }
});

test("a literal label or a vars-and-literals chain maps to the expression of its OS and a macOS or Arm label to none, so an implementation that maps every label to Linux or keeps a Blacksmith literal fails", () => {
  for (const label of ["macos-latest", "macos-14", "ubuntu-24.04-arm"])
    assert.equal(runsOnFor(label), undefined, label);
  for (const label of [
    "ubuntu-latest",
    "ubuntu-22.04",
    "self-hosted",
    "blacksmith-4vcpu-ubuntu-2404",
    "${{ vars.RUNNER_CI || 'ubuntu-latest' }}",
    "${{ vars.RUNNER_CI_SMALL || vars.RUNNER_CI || 'ubuntu-latest' }}",
    "${{ 'windows-latest' || 'ubuntu-latest' }}",
    LINUX,
  ])
    assert.equal(runsOnFor(label), LINUX, label);
  for (const label of [
    "windows-latest",
    "Windows-2022",
    "blacksmith-4vcpu-windows-2025",
    "${{ vars.RUNNER_WINDOWS || 'windows-latest' }}",
    WINDOWS,
  ])
    assert.equal(runsOnFor(label), WINDOWS, label);
});

test("any other expression stays unresolved, so an implementation that maps every string containing a literal to Linux fails", () => {
  for (const value of [
    "${{ matrix.os }}",
    "${{ github.event_name == 'push' && 'windows-latest' || 'ubuntu-latest' }}",
    "${{ fromJSON('[\"ubuntu-latest\"]')[0] }}",
    "ubuntu-${{ matrix.version }}",
    "${{ vars.RUNNER_CI && 'ubuntu-latest' }}",
  ])
    assert.equal(runsOnFor(value), undefined, value);
});

test("a literal runner, the Blacksmith literal of an earlier sync included, becomes the expression and a second run changes nothing, so a sync that keeps the literal or writes it back every run fails", () => {
  const before = workflowWith(
    "  lint:\n    runs-on: blacksmith-4vcpu-ubuntu-2404\n    steps:\n      - run: pnpm lint\n  win:\n    runs-on: windows-latest\n    steps:\n      - run: pnpm test\n",
  );
  const once = syncCi(before);
  assert.equal(jobsOf(once.content).lint["runs-on"], LINUX);
  assert.equal(jobsOf(once.content).win["runs-on"], WINDOWS);
  assert.match(
    once.content,
    /\n {4}runs-on: \$\{\{ vars\.RUNNER_CI \|\| \(github/,
  );
  assert.deepEqual(
    once.advisories.filter((note) => note.startsWith("Runner:")),
    [],
  );
  assert.equal(syncCi(once.content).content, once.content);
});

test("a job that calls a workflow keeps its fields and the verdict gets the Linux expression, so an implementation that rewrites job-level uses or leaves the verdict on a literal fails", () => {
  const text = syncCi(workflowWith("")).content;
  assert.equal(jobsOf(text).verdict["runs-on"], LINUX);
  assert.equal(jobsOf(text).ci["runs-on"], undefined);
  assert.equal(syncCi(text).content, text);
});

test("a runner sync cannot resolve stays and is reported once per job, so an implementation that rewrites a list to Linux or reports nothing fails", () => {
  for (const runsOn of [
    "[self-hosted, linux]",
    "{ group: ci, labels: [linux] }",
    "${{ github.event_name == 'push' && 'a' || 'b' }}",
  ]) {
    const result = syncCi(
      workflowWith(
        `  lint:\n    runs-on: ${runsOn}\n    steps:\n      - run: pnpm lint\n`,
      ),
    );
    assert.notEqual(jobsOf(result.content).lint["runs-on"], LINUX, runsOn);
    const runner = result.advisories.filter((note) =>
      note.startsWith("Runner:"),
    );
    assert.equal(runner.length, 1, runsOn);
    assert.match(
      runner[0],
      new RegExp(
        `^Runner: ${CI_PATH.replaceAll(".", "\\.")} job lint runs on .+, which sync cannot resolve to a Linux or Windows runner\\. Use a literal label\\.$`,
      ),
    );
  }
  assert.equal(runnerOf(LINUX), LINUX);
});

test("a matrix.os job keeps its list and runs on the ternary keyed on the list's own Windows label, the Blacksmith labels of an earlier sync included, so a sync that leaves runs-on on matrix.os or renames the list fails", () => {
  for (const [os, windows] of [
    ["[ubuntu-latest, windows-latest]", "windows-latest"],
    [
      "[blacksmith-4vcpu-ubuntu-2404, blacksmith-4vcpu-windows-2025]",
      "blacksmith-4vcpu-windows-2025",
    ],
  ] as const) {
    const text = syncCi(
      workflowWith(
        `  test:\n    runs-on: \${{ matrix.os }}\n    strategy:\n      matrix:\n        os: ${os}\n    steps:\n      - run: pnpm test\n`,
      ),
    );
    const job = jobsOf(text.content).test;
    assert.equal(
      job["runs-on"],
      MATRIX.replace("'windows-latest' &&", `'${windows}' &&`),
      os,
    );
    assert.deepEqual(job.strategy?.matrix?.os, os.slice(1, -1).split(", "));
    assert.deepEqual(
      text.advisories.filter((note) => note.startsWith("Runner:")),
      [],
    );
    assert.equal(syncCi(text.content).content, text.content);
  }
});

test("dms-database's matrix, whose exclude a step builds from the Blacksmith Windows label, keeps that label and resolves each leg by visibility, so a sync that renames the list under a generated exclude fails", () => {
  const text = syncCi(
    workflowWith(
      `  select:\n    runs-on: blacksmith-4vcpu-ubuntu-2404\n    outputs:\n      exclude-os: \${{ steps.tier.outputs.exclude-os }}\n    steps:\n      - id: tier\n        run: echo 'exclude-os=[{"os":"blacksmith-4vcpu-windows-2025"}]' >> "$GITHUB_OUTPUT"\n  frontend:\n    needs: select\n    strategy:\n      matrix:\n        os: [blacksmith-4vcpu-ubuntu-2404, blacksmith-4vcpu-windows-2025]\n        exclude: \${{ fromJSON(needs.select.outputs.exclude-os) }}\n    runs-on: \${{ matrix.os }}\n    steps:\n      - run: pnpm test:frontend\n`,
    ),
  );
  const job = jobsOf(text.content).frontend;
  assert.deepEqual(job.strategy?.matrix?.os, [
    "blacksmith-4vcpu-ubuntu-2404",
    "blacksmith-4vcpu-windows-2025",
  ]);
  const runsOn = String(job["runs-on"]);
  for (const visibility of ["public", "private"])
    for (const os of [
      "blacksmith-4vcpu-ubuntu-2404",
      "blacksmith-4vcpu-windows-2025",
    ])
      assert.equal(
        resolve(runsOn, { visibility, os }),
        visibility === "public"
          ? os.includes("windows")
            ? "windows-latest"
            : "ubuntu-latest"
          : os,
        `${visibility} ${os}`,
      );
  assert.deepEqual(
    text.advisories.filter((n) => n.startsWith("Runner:")),
    [],
  );
});

test("a matrix of GitHub labels that a step compares or an exclude names keeps its list and gets the ternary, so a sync that renames the labels those comparisons read fails", () => {
  for (const extra of [
    "    steps:\n      - if: matrix.os == 'windows-latest'\n        run: pnpm win\n      - shell: ${{ matrix.os == 'windows-latest' && 'pwsh' || 'bash' }}\n        run: pnpm test\n",
    "        node: [22, 24]\n        exclude:\n          - os: windows-latest\n            node: 22\n    steps:\n      - run: pnpm test\n",
  ]) {
    const text = syncCi(
      workflowWith(
        `  test:\n    runs-on: \${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, windows-latest]\n${extra}`,
      ),
    );
    const job = jobsOf(text.content).test;
    assert.equal(job["runs-on"], MATRIX);
    assert.deepEqual(job.strategy?.matrix?.os, [
      "ubuntu-latest",
      "windows-latest",
    ]);
    assert.deepEqual(
      text.advisories.filter((n) => n.startsWith("Runner:")),
      [],
    );
  }
});

test("the Windows ternary of an earlier sync becomes the expression ternary on the same key, so a sync that keeps its Blacksmith literals or drops the comparison fails", () => {
  const before =
    "${{ matrix.os == 'windows-latest' && 'blacksmith-4vcpu-windows-2025' || 'blacksmith-4vcpu-ubuntu-2404' }}";
  const text = syncCi(
    workflowWith(
      `  test:\n    runs-on: ${before}\n    strategy:\n      matrix:\n        os: \${{ fromJSON(vars.OSES) }}\n    steps:\n      - run: pnpm test\n`,
    ),
  );
  assert.equal(jobsOf(text.content).test["runs-on"], MATRIX);
  assert.deepEqual(
    text.advisories.filter((n) => n.startsWith("Runner:")),
    [],
  );
  assert.equal(syncCi(text.content).content, text.content);
});

test("a matrix sync cannot read is reported and untouched, so an implementation that rewrites a generated list or item, keys one ternary on two Windows labels, drops a ternary branch that names another runner, or moves macOS to Linux fails", () => {
  for (const job of [
    "  test:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: ${{ fromJSON(vars.OSES) }}\n    steps:\n      - run: pnpm test\n",
    "  test:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [windows-2022, windows-latest]\n    steps:\n      - run: pnpm win\n",
    "  test:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, macos-latest]\n    steps:\n      - run: pnpm test\n",
    "  test:\n    runs-on: ${{ matrix.os == 'macos-latest' && 'a' || 'b' }}\n    steps:\n      - run: pnpm test\n",
    "  test:\n    runs-on: ${{ matrix.os == 'windows-latest' && 'blacksmith-4vcpu-windows-2025' || matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, macos-latest, windows-latest]\n    steps:\n      - run: pnpm test\n",
    "  test:\n    runs-on: ${{ matrix.os == 'windows-latest' && 'windows-latest' || 'macos-latest' }}\n    strategy:\n      matrix:\n        os: [macos-latest, windows-latest]\n    steps:\n      - run: pnpm test\n",
    "  test:\n    runs-on: ${{ matrix.os == 'windows-latest' && inputs.win || inputs.lin }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, windows-latest]\n    steps:\n      - run: pnpm test\n",
    "  test:\n    runs-on: ${{ matrix.os == 'windows-latest' && 'windows-latest' || 'ubuntu-latest' }}\n    steps:\n      - run: pnpm test\n",
    "  test:\n    runs-on: ${{ matrix.os == 'windows-latest' && 'windows-latest' || 'ubuntu-latest' }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, windows-2022]\n    steps:\n      - run: pnpm test\n",
    "  test:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, '${{ inputs.os }}']\n    steps:\n      - run: pnpm test\n",
  ]) {
    const kept = syncCi(workflowWith(job));
    assert.notEqual(jobsOf(kept.content).test["runs-on"], MATRIX, job);
    assert.equal(
      kept.advisories.filter((n) => n.startsWith("Runner:")).length,
      1,
      job,
    );
  }
});

const SELECT = `  select:\n    runs-on: ${LINUX}\n    outputs:\n      windows: \${{ steps.tier.outputs.windows }}\n      os: \${{ steps.tier.outputs.os }}\n    steps:\n      - id: tier\n        run: echo 'windows=[]' >> "$GITHUB_OUTPUT"\n`;

function matrixJob(runsOn: string, matrix: string): string {
  return `${SELECT}  backend:\n    needs: select\n    runs-on: ${runsOn}\n    strategy:\n      matrix:\n${matrix}    steps:\n      - run: pnpm test\n`;
}

function runnerAdvisories(advisories: readonly string[]): string[] {
  return advisories.filter((note) => note.startsWith("Runner:"));
}

const PUBLIC_LABEL = { linux: "ubuntu-latest", windows: "windows-latest" };

function legOs(label: string): "linux" | "windows" {
  return /windows/i.test(label) ? "windows" : "linux";
}

/** Asserts that `runsOn` puts each leg of `legs` on a runner of that leg's own OS, for a public and a private repository. */
function assertEachLegKeepsItsOs(
  runsOn: string,
  legs: readonly string[],
): void {
  for (const leg of legs) {
    const os = legOs(leg);
    assert.equal(
      resolve(runsOn, { visibility: "public", os: leg }),
      PUBLIC_LABEL[os],
      `public ${leg}`,
    );
    assert.equal(
      resolve(runsOn, { visibility: "private", os: leg }),
      os === "windows"
        ? "blacksmith-4vcpu-windows-2025"
        : "blacksmith-4vcpu-ubuntu-2404",
      `private ${leg}`,
    );
  }
}

test("dms-marketing's backend, whose generated include adds the Windows leg, keeps ${{ matrix.os }} and gets an advisory that names the include, so a sync that reads the literal list as the whole matrix and moves the nightly Windows leg to Linux fails", () => {
  const text = syncCi(
    workflowWith(
      matrixJob(
        "${{ matrix.os }}",
        "        os: [blacksmith-4vcpu-ubuntu-2404]\n        include: ${{ fromJSON(needs.select.outputs.windows) }}\n",
      ),
    ),
  );
  assert.equal(jobsOf(text.content).backend["runs-on"], "${{ matrix.os }}");
  const [advisory, ...rest] = runnerAdvisories(text.advisories);
  assert.deepEqual(rest, []);
  assert.match(advisory, /job backend .*include is generated/);
  assert.equal(syncCi(text.content).content, text.content);
});

test("a matrix whose include sync cannot read is left alone with the reason, and a literal include item is read as a leg, so a sync that skips an include item or treats an os-less item as unreadable fails", () => {
  for (const [matrix, why] of [
    [
      "        os: [ubuntu-latest]\n        include:\n          - ${{ fromJSON(vars.LEG) }}\n",
      /include item is generated/,
    ],
    [
      "        os: [ubuntu-latest]\n        include:\n          - os: ${{ inputs.os }}\n",
      /expression/,
    ],
    ["        os: [ubuntu-latest, '${{ inputs.os }}']\n", /expression/],
    [
      "        os: ${{ fromJSON(needs.select.outputs.os) }}\n",
      /os is generated/,
    ],
  ] as const) {
    const text = syncCi(workflowWith(matrixJob("${{ matrix.os }}", matrix)));
    assert.equal(
      jobsOf(text.content).backend["runs-on"],
      "${{ matrix.os }}",
      matrix,
    );
    const advisories = runnerAdvisories(text.advisories);
    assert.equal(advisories.length, 1, matrix);
    assert.match(advisories[0], why, matrix);
  }
  const literal = syncCi(
    workflowWith(
      matrixJob(
        "${{ matrix.os }}",
        "        os: [blacksmith-4vcpu-ubuntu-2404]\n        node: [22, 24]\n        include:\n          - node: 24\n            coverage: true\n          - os: blacksmith-4vcpu-windows-2025\n            node: 24\n",
      ),
    ),
  );
  const runsOn = String(jobsOf(literal.content).backend["runs-on"]);
  assert.deepEqual(runnerAdvisories(literal.advisories), []);
  assertEachLegKeepsItsOs(runsOn, [
    "blacksmith-4vcpu-ubuntu-2404",
    "blacksmith-4vcpu-windows-2025",
  ]);
});

test("dms-saas's ternary keyed on the Linux label becomes the expression ternary on that label and keeps each leg on its OS, so a sync that leaves the mirror with an advisory or swaps its branches fails", () => {
  const before =
    "${{ matrix.os == 'ubuntu-latest' && 'blacksmith-4vcpu-ubuntu-2404' || 'blacksmith-4vcpu-windows-2025' }}";
  const text = syncCi(
    workflowWith(
      matrixJob(
        before,
        "        os: ${{ fromJSON(needs.select.outputs.os) }}\n",
      ),
    ),
  );
  const runsOn = String(jobsOf(text.content).backend["runs-on"]);
  assert.match(
    runsOn,
    /^\$\{\{ matrix\.os == 'ubuntu-latest' && \(vars\.RUNNER_CI \|\|/,
  );
  assert.deepEqual(runnerAdvisories(text.advisories), []);
  assertEachLegKeepsItsOs(runsOn, ["ubuntu-latest", "windows-latest"]);
  assert.equal(syncCi(text.content).content, text.content);
});

test("every matrix expression sync writes keeps each leg on its own OS for a public and a private repository, so an expression keyed on the wrong label or with swapped branches fails", () => {
  const cases = [
    [
      "${{ matrix.os }}",
      "        os: [ubuntu-latest, windows-latest]\n",
      ["ubuntu-latest", "windows-latest"],
    ],
    [
      "${{ matrix.os }}",
      "        os: [blacksmith-4vcpu-ubuntu-2404, blacksmith-4vcpu-windows-2025]\n        exclude: ${{ fromJSON(needs.select.outputs.os) }}\n",
      ["blacksmith-4vcpu-ubuntu-2404", "blacksmith-4vcpu-windows-2025"],
    ],
    ["${{ matrix.os }}", "        os: [ubuntu-latest]\n", ["ubuntu-latest"]],
    ["${{ matrix.os }}", "        os: [windows-latest]\n", ["windows-latest"]],
    [
      "${{ matrix.os == 'windows-latest' && 'blacksmith-4vcpu-windows-2025' || 'blacksmith-4vcpu-ubuntu-2404' }}",
      "        os: ${{ fromJSON(needs.select.outputs.os) }}\n",
      ["ubuntu-latest", "windows-latest"],
    ],
    [
      "${{ matrix.os == 'blacksmith-4vcpu-ubuntu-2404' && 'blacksmith-4vcpu-ubuntu-2404' || 'blacksmith-4vcpu-windows-2025' }}",
      "        os: [blacksmith-4vcpu-ubuntu-2404, blacksmith-4vcpu-windows-2025]\n",
      ["blacksmith-4vcpu-ubuntu-2404", "blacksmith-4vcpu-windows-2025"],
    ],
  ] as const;
  for (const [runsOn, matrix, legs] of cases) {
    const text = syncCi(workflowWith(matrixJob(runsOn, matrix)));
    const written = String(jobsOf(text.content).backend["runs-on"]);
    assert.notEqual(written, runsOn, runsOn);
    assert.deepEqual(
      runnerAdvisories(text.advisories),
      [],
      `${runsOn} ${matrix}`,
    );
    assertEachLegKeepsItsOs(written, legs);
  }
});
