import assert from "node:assert/strict";
import test from "node:test";

import { RUNS_ON } from "./ci-hand-jobs.ts";
import { jobsOf, syncCi, workflowWith } from "./helpers/ci-text.ts";
import { resolve } from "./helpers/runner-expression.ts";

const LINUX = RUNS_ON.linux;

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

test("a ternary already in the expression form, a ternary of variables, or a matrix label of no known OS is left alone when a leg would land on another OS, so a sync that trusts the canonical form, any variable or a Linux default fails", () => {
  const linuxKeyed = String(
    jobsOf(
      syncCi(
        workflowWith(
          matrixJob(
            "${{ matrix.os == 'ubuntu-latest' && 'blacksmith-4vcpu-ubuntu-2404' || 'blacksmith-4vcpu-windows-2025' }}",
            "        os: ${{ fromJSON(needs.select.outputs.os) }}\n",
          ),
        ),
      ).content,
    ).backend["runs-on"],
  );
  for (const [runsOn, matrix] of [
    [linuxKeyed, "        os: [ubuntu-22.04, windows-latest]\n"],
    [
      "${{ matrix.os == 'ubuntu-latest' && vars.RUNNER_CI_WINDOWS || vars.RUNNER_CI }}",
      "        os: [ubuntu-latest, windows-latest]\n",
    ],
    [
      "${{ matrix.os == 'windows-latest' && vars.RUNNER_CI || vars.RUNNER_CI_WINDOWS }}",
      "        os: [ubuntu-latest, windows-latest]\n",
    ],
    ["${{ matrix.os }}", "        os: [win-2022]\n"],
    ["${{ matrix.os }}", "        os: [self-hosted, windows-latest]\n"],
  ] as const) {
    const text = syncCi(workflowWith(matrixJob(runsOn, matrix)));
    assert.equal(
      jobsOf(text.content).backend["runs-on"],
      runsOn,
      `${runsOn} ${matrix}`,
    );
    assert.equal(
      runnerAdvisories(text.advisories).length,
      1,
      `${runsOn} ${matrix}`,
    );
  }
  const variables = syncCi(
    workflowWith(
      matrixJob(
        "${{ matrix.os == 'windows-latest' && vars.RUNNER_CI_WINDOWS || vars.RUNNER_CI }}",
        "        os: [ubuntu-latest, windows-latest]\n",
      ),
    ),
  );
  assert.deepEqual(runnerAdvisories(variables.advisories), []);
  assertEachLegKeepsItsOs(
    String(jobsOf(variables.content).backend["runs-on"]),
    ["ubuntu-latest", "windows-latest"],
  );
});

test("an os key spelled in another case, in an include item or the matrix itself, or a merge key there, leaves the job alone with the reason, so a sync that reads only the exact key os and moves the include's windows-latest leg to Linux fails", () => {
  for (const [matrix, why] of [
    [
      "        os: [ubuntu-latest]\n        include:\n          - OS: windows-latest\n",
      /OS/,
    ],
    [
      "        os: [ubuntu-latest]\n        include:\n          - Os: windows-latest\n            node: 22\n",
      /Os/,
    ],
    ["        os: [ubuntu-latest]\n        OS: [windows-latest]\n", /OS/],
    [
      "        os: [ubuntu-latest]\n        include:\n          - <<: { os: windows-latest }\n            node: 22\n",
      /merge key/,
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
});

test("a ternary on a matrix whose os key is spelled in another case is left alone, and an exclude item's key never adds a leg so it keeps the rewrite, so a sync that keys a ternary on an unread include or refuses an exclude fails", () => {
  const ternary = syncCi(
    workflowWith(
      matrixJob(
        "${{ matrix.os == 'windows-latest' && 'blacksmith-4vcpu-windows-2025' || 'blacksmith-4vcpu-ubuntu-2404' }}",
        "        os: [ubuntu-latest, windows-latest]\n        include:\n          - OS: windows-2022\n",
      ),
    ),
  );
  assert.equal(runnerAdvisories(ternary.advisories).length, 1);
  assert.match(
    String(jobsOf(ternary.content).backend["runs-on"]),
    /'blacksmith-4vcpu-windows-2025' \|\|/,
  );
  const excluded = syncCi(
    workflowWith(
      matrixJob(
        "${{ matrix.os }}",
        "        os: [ubuntu-latest, windows-latest]\n        node: [22, 24]\n        exclude:\n          - OS: windows-latest\n            node: 22\n",
      ),
    ),
  );
  assert.deepEqual(runnerAdvisories(excluded.advisories), []);
  assertEachLegKeepsItsOs(String(jobsOf(excluded.content).backend["runs-on"]), [
    "ubuntu-latest",
    "windows-latest",
  ]);
  for (const runsOn of [
    "${{ matrix.OS }}",
    "${{ matrix.OS == 'windows-latest' && 'a' || 'b' }}",
  ]) {
    const text = syncCi(
      workflowWith(
        matrixJob(runsOn, "        os: [ubuntu-latest, windows-latest]\n"),
      ),
    );
    assert.equal(jobsOf(text.content).backend["runs-on"], runsOn, runsOn);
    assert.equal(runnerAdvisories(text.advisories).length, 1, runsOn);
  }
});

test("a matrix or include item key that is an alias, or an include key spelled in another case, leaves the job alone with the reason, so a sync that reads past a key it cannot name and moves the windows-latest leg to Linux fails", () => {
  const anchored = (job: string) =>
    workflowWith(
      `  anchors:\n    runs-on: ${LINUX}\n    env:\n      K: &k os\n    steps:\n      - run: echo\n${job}`,
    );
  for (const [text, why] of [
    [
      anchored(
        matrixJob(
          "${{ matrix.os }}",
          "        os: [ubuntu-latest]\n        include:\n          - *k : windows-latest\n",
        ),
      ),
      /key sync cannot read/,
    ],
    [
      anchored(
        matrixJob(
          "${{ matrix.os }}",
          "        os: [ubuntu-latest]\n        *k : [windows-latest]\n",
        ),
      ),
      /key sync cannot read/,
    ],
    [
      workflowWith(
        matrixJob(
          "${{ matrix.os }}",
          "        os: [ubuntu-latest]\n        Include:\n          - os: windows-latest\n",
        ),
      ),
      /Include/,
    ],
  ] as const) {
    const result = syncCi(text);
    assert.equal(
      jobsOf(result.content).backend["runs-on"],
      "${{ matrix.os }}",
      text,
    );
    const advisories = runnerAdvisories(result.advisories);
    assert.equal(advisories.length, 1, text);
    assert.match(advisories[0], why, text);
  }
});
